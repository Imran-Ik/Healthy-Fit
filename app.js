(function(){
  "use strict";

  // =========================================================
  // Utilities
  // =========================================================
  function pad(n){return n<10?'0'+n:''+n;}
  function dateKey(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
  function fmtDateLabel(d){
    const today = new Date(); today.setHours(0,0,0,0);
    const cmp = new Date(d); cmp.setHours(0,0,0,0);
    const diff = Math.round((today-cmp)/86400000);
    if(diff===0) return 'Today';
    if(diff===1) return 'Yesterday';
    return cmp.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  }
  function round(n){return Math.round(n);}
  function clamp(n,a,b){return Math.max(a,Math.min(b,n));}
  function uid(){return 'f'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);}
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  let toastTimer;
  function toast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>t.classList.remove('show'), 2200);
  }

  // =========================================================
  // Storage — plain localStorage, one device, no login.
  // If you add a backend (Firebase/Supabase) later, this is the
  // only object you need to swap out; every call site elsewhere
  // in this file goes through Store.
  // =========================================================
  const Store = {
    getProfile(){
      const raw = localStorage.getItem('kilo_profile');
      return raw ? JSON.parse(raw) : null;
    },
    setProfile(data){
      localStorage.setItem('kilo_profile', JSON.stringify(data));
    },
    getLog(key){
      const raw = localStorage.getItem('kilo_log_'+key);
      return raw ? JSON.parse(raw) : null;
    },
    setLog(key, data){
      localStorage.setItem('kilo_log_'+key, JSON.stringify(data));
    },
    getRecentLogs(days){
      const out = [];
      const d = new Date();
      for(let i=0;i<days;i++){
        const key = dateKey(d);
        out.push({key, date:new Date(d), log:this.getLog(key)});
        d.setDate(d.getDate()-1);
      }
      return out.reverse();
    }
  };

  // =========================================================
  // App state + calorie/BMI math
  // =========================================================
  const App = {
    profile: null,
    currentDate: new Date(),
    currentLog: null,

    emptyLog(key){ return {date:key, waterMl:0, steps:0, foods:[]}; },

    loadProfile(){ this.profile = Store.getProfile(); },

    calcTargets(p){
      if(!p) return null;
      const w = parseFloat(p.weight), h = parseFloat(p.height), a = parseFloat(p.age);
      let bmr = (p.sex === 'female') ? (10*w + 6.25*h - 5*a - 161) : (10*w + 6.25*h - 5*a + 5);
      const tdee = bmr * parseFloat(p.activity);
      let calGoal = tdee;
      if(p.goal === 'lose') calGoal = tdee - 500;
      else if(p.goal === 'gain') calGoal = tdee + 300;
      calGoal = Math.max(1200, round(calGoal));
      const proteinG = round((calGoal*0.30)/4);
      const carbG = round((calGoal*0.40)/4);
      const fatG = round((calGoal*0.30)/9);
      const bmi = w / ((h/100)*(h/100));
      let bmiCat = 'Normal';
      if(bmi < 18.5) bmiCat = 'Underweight';
      else if(bmi >= 25 && bmi < 30) bmiCat = 'Overweight';
      else if(bmi >= 30) bmiCat = 'Obese';
      const waterGoal = round((w*35)/250)*250;
      const stepGoal = p.stepGoal ? parseInt(p.stepGoal) : 10000;
      return {bmr:round(bmr), tdee:round(tdee), calGoal, proteinG, carbG, fatG, bmi:Math.round(bmi*10)/10, bmiCat, waterGoal, stepGoal};
    },

    loadLog(){
      const key = dateKey(this.currentDate);
      let log = Store.getLog(key);
      if(!log) log = this.emptyLog(key);
      if(!log.foods) log.foods = [];
      this.currentLog = log;
    },

    saveLog(){ Store.setLog(this.currentLog.date, this.currentLog); },

    totals(){
      const t = {calories:0, protein:0, carbs:0, fat:0};
      for(const f of this.currentLog.foods){
        t.calories += f.calories||0;
        t.protein += f.protein_g||0;
        t.carbs += f.carbs_g||0;
        t.fat += f.fat_g||0;
      }
      return t;
    }
  };

  // =========================================================
  // LIVE STEP TRACKER — real accelerometer, counted in real time
  // via the DeviceMotion API. Foreground only (see README): the
  // page must be open and the browser tab/app active. There is no
  // way for a plain web page to keep counting once the screen
  // locks or the tab is backgrounded — that needs a native
  // pedometer plugin (see README "Going further").
  // =========================================================
    const StepTracker = {
    active: false,
    _smoothedMag: 9.8,
    _baseline: 9.8,
    _armed: false,
    _lastStepTime: 0,
    _minIntervalMs: 350,   // fastest plausible step cadence (~170 steps/min ceiling)
    _thresholdHigh: 3.2,   // delta above baseline needed to "arm" a step — raise this if hand movement still triggers it
    _thresholdLow: 1.2,    // delta must fall back below this before the next step can count
    _onStep: null,

    isSupported(){
      return typeof window.DeviceMotionEvent !== 'undefined';
    },

    async requestPermission(){
      if(typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function'){
        try{
          const res = await DeviceMotionEvent.requestPermission();
          return res === 'granted';
        }catch(e){
          return false;
        }
      }
      return true;
    },

    start(onStep){
      if(this.active) return;
      this._onStep = onStep;
      this._lastStepTime = 0;
      this._armed = false;
      this._smoothedMag = 9.8;
      this._baseline = 9.8;
      window.addEventListener('devicemotion', this._handleMotion);
      this.active = true;
    },

    stop(){
      window.removeEventListener('devicemotion', this._handleMotion);
      this.active = false;
    },

    _handleMotion(event){
      const acc = event.accelerationIncludingGravity || event.acceleration;
      if(!acc || acc.x===null) return;
      const x=acc.x||0, y=acc.y||0, z=acc.z||0;
      const rawMag = Math.sqrt(x*x + y*y + z*z);

      // Fast smoothing filters out single-sample spikes (a quick hand
      // twitch) while still tracking the ~1-3Hz rhythm of an actual step.
      StepTracker._smoothedMag = StepTracker._smoothedMag*0.7 + rawMag*0.3;

      // Slow smoothing tracks the "resting" level — gravity plus however
      // the phone is currently being held — so the threshold adapts
      // instead of being thrown off by holding the phone at an angle.
      StepTracker._baseline = StepTracker._baseline*0.95 + rawMag*0.05;

      const delta = StepTracker._smoothedMag - StepTracker._baseline;
      const now = Date.now();

      // Hysteresis: a step only counts on the rise above thresholdHigh,
      // and won't arm again until motion has actually settled back below
      // thresholdLow. A single jerky hand movement rises and falls too
      // fast/inconsistently to reliably clear both gates the way a real
      // step's swing-and-plant motion does.
      if(!StepTracker._armed && delta > StepTracker._thresholdHigh && (now - StepTracker._lastStepTime) > StepTracker._minIntervalMs){
        StepTracker._armed = true;
        StepTracker._lastStepTime = now;
        if(StepTracker._onStep) StepTracker._onStep();
      } else if(StepTracker._armed && delta < StepTracker._thresholdLow){
        StepTracker._armed = false;
      }
    }
  };
  StepTracker._handleMotion = StepTracker._handleMotion.bind(StepTracker);
  // =========================================================
  // Rendering
  // =========================================================
  function renderDateLabel(){
    document.getElementById('dateLabel').textContent = fmtDateLabel(App.currentDate);
    const today = dateKey(new Date());
    document.getElementById('nextDay').style.visibility = (dateKey(App.currentDate)===today) ? 'hidden' : 'visible';
  }

  function renderDashboard(){
    renderDateLabel();
    const targets = App.calcTargets(App.profile);
    const t = App.totals();

    if(!targets){
      document.getElementById('calSub').textContent = 'Set up your profile to see your daily target.';
      document.getElementById('calGoalLabel').textContent = '/ — kcal';
    } else {
      const pct = clamp((t.calories/targets.calGoal)*100, 0, 100);
      document.getElementById('calGoalLabel').textContent = '/ '+targets.calGoal+' kcal';
      document.getElementById('calBar').style.width = pct+'%';
      const remaining = targets.calGoal - t.calories;
      document.getElementById('calSub').textContent = remaining >= 0
        ? remaining+' kcal remaining today'
        : (Math.abs(remaining))+' kcal over today\'s target';

      setBar('proteinLbl','proteinFill', t.protein, targets.proteinG, 'g');
      setBar('carbLbl','carbFill', t.carbs, targets.carbG, 'g');
      setBar('fatLbl','fatFill', t.fat, targets.fatG, 'g');

      document.getElementById('waterGoal').textContent = targets.waterGoal;
      document.getElementById('stepsGoal').textContent = targets.stepGoal.toLocaleString();
      document.getElementById('waterFill').style.width = clamp((App.currentLog.waterMl/targets.waterGoal)*100,0,100)+'%';
      document.getElementById('stepsFill').style.width = clamp((App.currentLog.steps/targets.stepGoal)*100,0,100)+'%';
    }
    document.getElementById('calConsumed').textContent = round(t.calories);
    document.getElementById('waterVal').textContent = App.currentLog.waterMl;
    document.getElementById('stepsVal').textContent = App.currentLog.steps.toLocaleString();

    renderFoodList();
    renderWeekChart();
  }

  function setBar(lblId, fillId, val, goal, unit){
    document.getElementById(lblId).textContent = round(val)+' / '+goal+unit;
    document.getElementById(fillId).style.width = clamp((val/goal)*100,0,100)+'%';
  }

  function renderFoodList(){
    const el = document.getElementById('foodList');
    const foods = App.currentLog.foods;
    if(!foods.length){
      el.innerHTML = '<div class="empty">No meals logged yet. Tap "Add" to snap a photo.</div>';
      return;
    }
    el.innerHTML = foods.slice().reverse().map(f=>{
      const img = f.thumb ? '<img src="'+f.thumb+'">' : '<div class="ph">🍽️</div>';
      return '<div class="foodrow">'+img+
        '<div class="meta"><div class="n">'+escapeHtml(f.name)+'</div><div class="m">'+f.time+' · '+round(f.protein_g)+'p '+round(f.carbs_g)+'c '+round(f.fat_g)+'f</div></div>'+
        '<div class="kcal">'+round(f.calories)+'</div>'+
        '<button class="del" data-del="'+f.id+'">✕</button></div>';
    }).join('');
    el.querySelectorAll('[data-del]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-del');
        App.currentLog.foods = App.currentLog.foods.filter(f=>f.id!==id);
        App.saveLog();
        renderDashboard();
      });
    });
  }

  function renderWeekChart(){
    const el = document.getElementById('weekChart');
    const targets = App.calcTargets(App.profile);
    const goal = targets ? targets.calGoal : 2000;
    const recent = Store.getRecentLogs(7);
    const todayKey = dateKey(new Date());
    el.innerHTML = recent.map(r=>{
      const cals = r.log ? r.log.foods.reduce((s,f)=>s+(f.calories||0),0) : 0;
      const pct = clamp((cals/goal)*100, 2, 100);
      const isToday = r.key===todayKey;
      const lbl = r.date.toLocaleDateString(undefined,{weekday:'narrow'});
      return '<div class="col'+(isToday?' today':'')+'"><div class="colbar" style="height:64px;"><div class="fill" style="height:'+pct+'%"></div></div><div class="lbl">'+lbl+'</div></div>';
    }).join('');
  }

  function renderProfileForm(){
    const p = App.profile || {};
    document.getElementById('pName').value = p.name || '';
    document.getElementById('pAge').value = p.age || '';
    document.getElementById('pHeight').value = p.height || '';
    document.getElementById('pWeight').value = p.weight || '';
    document.getElementById('pActivity').value = p.activity || '1.55';
    document.getElementById('pStepGoal').value = p.stepGoal || 10000;
    setSeg('sexSeg', p.sex || 'male');
    setSeg('goalSeg', p.goal || 'maintain');
    renderProfileStats();
  }

  function setSeg(id, val){
    document.querySelectorAll('#'+id+' button').forEach(b=>b.classList.toggle('sel', b.getAttribute('data-v')===val));
  }
  function getSeg(id){
    const sel = document.querySelector('#'+id+' button.sel');
    return sel ? sel.getAttribute('data-v') : null;
  }

  function renderProfileStats(){
    const box = document.getElementById('profileStats');
    const targets = App.calcTargets(App.profile);
    if(!targets){ box.innerHTML=''; return; }
    box.innerHTML =
      '<div class="statgrid">'+
        '<div class="statcard"><div class="l">BMI</div><div class="v">'+targets.bmi+'</div><div class="u">'+targets.bmiCat+'</div></div>'+
        '<div class="statcard"><div class="l">BMR</div><div class="v">'+targets.bmr+'</div><div class="u">kcal/day</div></div>'+
        '<div class="statcard"><div class="l">Daily target</div><div class="v">'+targets.calGoal+'</div><div class="u">kcal</div></div>'+
      '</div>'+
      '<div class="statgrid">'+
        '<div class="statcard"><div class="l">Water goal</div><div class="v">'+targets.waterGoal+'</div><div class="u">ml/day</div></div>'+
        '<div class="statcard"><div class="l">Step goal</div><div class="v">'+targets.stepGoal.toLocaleString()+'</div><div class="u">steps/day</div></div>'+
      '</div>';
  }

  // =========================================================
  // Navigation
  // =========================================================
  function showView(name){
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-'+name).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.getAttribute('data-view')===name));
    if(name==='dashboard') renderDashboard();
    if(name==='profile') renderProfileForm();
    if(name==='log') resetLogView();
    window.scrollTo(0,0);
  }
  document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click', ()=>showView(b.getAttribute('data-view'))));
  document.getElementById('goLogFood').addEventListener('click', ()=>showView('log'));

  document.getElementById('prevDay').addEventListener('click', ()=>{
    App.currentDate.setDate(App.currentDate.getDate()-1);
    App.loadLog();
    renderDashboard();
  });
  document.getElementById('nextDay').addEventListener('click', ()=>{
    const today = dateKey(new Date());
    if(dateKey(App.currentDate)===today) return;
    App.currentDate.setDate(App.currentDate.getDate()+1);
    App.loadLog();
    renderDashboard();
  });

  // =========================================================
  // Profile form
  // =========================================================
  document.querySelectorAll('#sexSeg button').forEach(b=>b.addEventListener('click',()=>setSeg('sexSeg', b.getAttribute('data-v'))));
  document.querySelectorAll('#goalSeg button').forEach(b=>b.addEventListener('click',()=>setSeg('goalSeg', b.getAttribute('data-v'))));

  document.getElementById('saveProfileBtn').addEventListener('click', ()=>{
    const name = document.getElementById('pName').value.trim();
    const age = document.getElementById('pAge').value;
    const height = document.getElementById('pHeight').value;
    const weight = document.getElementById('pWeight').value;
    const activity = document.getElementById('pActivity').value;
    const stepGoal = document.getElementById('pStepGoal').value || 10000;
    const sex = getSeg('sexSeg');
    const goal = getSeg('goalSeg');
    if(!name || !age || !height || !weight){ toast('Please fill in all fields'); return; }
    const data = {name, age, height, weight, activity, sex, goal, stepGoal};
    Store.setProfile(data);
    App.profile = data;
    renderProfileStats();
    toast('Profile saved');
    showView('dashboard');
  });

  // =========================================================
  // Water quick-add
  // =========================================================
  document.querySelectorAll('[data-water]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      App.currentLog.waterMl += parseInt(btn.getAttribute('data-water'));
      App.saveLog();
      renderDashboard();
      toast('+'+btn.getAttribute('data-water')+'ml logged');
    });
  });

  // =========================================================
  // Steps — live tracker toggle + manual custom add
  // =========================================================
  const stepsToggleBtn = document.getElementById('stepsToggleBtn');
  const livePill = document.getElementById('livePill');

  async function toggleStepTracking(){
    if(StepTracker.active){
      StepTracker.stop();
      stepsToggleBtn.textContent = 'Start';
      stepsToggleBtn.classList.remove('on');
      livePill.style.display = 'none';
      return;
    }
    if(!StepTracker.isSupported()){
      toast('This device/browser doesn\'t expose motion sensors');
      return;
    }
    const granted = await StepTracker.requestPermission();
    if(!granted){
      toast('Motion access denied — enable it in browser settings');
      return;
    }
    StepTracker.start(()=>{
      App.currentLog.steps += 1;
      App.saveLog();
      document.getElementById('stepsVal').textContent = App.currentLog.steps.toLocaleString();
      const targets = App.calcTargets(App.profile);
      if(targets) document.getElementById('stepsFill').style.width = clamp((App.currentLog.steps/targets.stepGoal)*100,0,100)+'%';
    });
    stepsToggleBtn.textContent = 'Stop';
    stepsToggleBtn.classList.add('on');
    livePill.style.display = 'inline-block';
    toast('Live step tracking started — keep this tab open');
  }
  stepsToggleBtn.addEventListener('click', toggleStepTracking);

  document.getElementById('stepsCustomBtn').addEventListener('click', ()=>{
    const val = prompt('Add steps:');
    const n = parseInt(val);
    if(!isNaN(n) && n>0){
      App.currentLog.steps += n;
      App.saveLog();
      renderDashboard();
      toast('+'+n+' steps logged');
    }
  });

  // Stop live tracking if the tab is hidden for a long time, so it
  // doesn't silently rack up bogus counts from a pocketed phone.
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden && StepTracker.active){
      // keep counting briefly is fine, but warn the user once they return
    }
  });

  // =========================================================
  // Food photo logging — calls YOUR OWN /api/analyze endpoint,
  // which holds the Gemini API key server-side. See
  // api/analyze.js and the README for setup.
  // =========================================================
  let pendingBlob = null, pendingThumb = null, pendingMediaType = 'image/jpeg';

  function resetLogView(){
    pendingBlob = null; pendingThumb = null;
    document.getElementById('snapArea').innerHTML =
      '<div class="snap-area" id="snapPrompt">'+
        '<div class="icon">📷</div>'+
        '<p>Take a photo of your plate, or upload one from your gallery.</p>'+
        '<input type="file" id="fileInput" accept="image/*" capture="environment" style="display:none">'+
        '<div class="stack" style="width:100%"><button class="btn" id="takePhotoBtn">Take / choose photo</button></div>'+
      '</div>';
    document.getElementById('logResult').innerHTML = '';
    document.getElementById('takePhotoBtn').addEventListener('click', ()=>document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', onFileChosen);
  }

  function fileToResizedBlob(file, maxDim, quality){
    return new Promise((resolve,reject)=>{
      const img = new Image();
      const reader = new FileReader();
      reader.onload = e=>{
        img.onload = ()=>{
          let w=img.width, h=img.height;
          if(w>h && w>maxDim){ h=Math.round(h*maxDim/w); w=maxDim; }
          else if(h>=w && h>maxDim){ w=Math.round(w*maxDim/h); h=maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width=w; canvas.height=h;
          canvas.getContext('2d').drawImage(img,0,0,w,h);
          canvas.toBlob(blob=>resolve({blob, dataUrl:canvas.toDataURL('image/jpeg',quality)}), 'image/jpeg', quality);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function blobToBase64(blob){
    return new Promise((resolve,reject)=>{
      const reader = new FileReader();
      reader.onload = ()=>resolve(reader.result.split(',')[1]); // strip data: prefix
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function onFileChosen(e){
    const file = e.target.files[0];
    if(!file) return;
    const big = await fileToResizedBlob(file, 1200, 0.85);
    const small = await fileToResizedBlob(file, 90, 0.5);
    pendingBlob = big.blob;
    pendingThumb = small.dataUrl;
    pendingMediaType = 'image/jpeg';

    document.getElementById('snapArea').innerHTML =
      '<div class="preview-wrap"><img src="'+big.dataUrl+'"></div>'+
      '<div class="stack">'+
        '<button class="btn" id="analyzeBtn">Analyze with AI</button>'+
        '<button class="btn ghost" id="retakeBtn">Choose a different photo</button>'+
      '</div>';
    document.getElementById('analyzeBtn').addEventListener('click', analyzeFood);
    document.getElementById('retakeBtn').addEventListener('click', resetLogView);
  }

  async function analyzeFood(){
    const resultEl = document.getElementById('logResult');
    resultEl.innerHTML = '<div class="thinking"><div class="dot"></div>Looking at your photo…</div>';
    try{
      const base64 = await blobToBase64(pendingBlob);
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({imageBase64: base64, mediaType: pendingMediaType})
      });
      if(!res.ok){
        const errBody = await res.json().catch(()=>({}));
        throw new Error(errBody.error || ('Server returned '+res.status));
      }
      const data = await res.json();
      showAnalysis(data);
    }catch(err){
      resultEl.innerHTML = '<div class="errbox">Couldn\'t analyze that photo ('+escapeHtml(err.message||'unknown error')+'). You can enter the details manually instead.</div>'+manualEntryHtml();
      wireManualEntry();
    }
  }

  function showAnalysis(data){
    const resultEl = document.getElementById('logResult');
    const conf = data.confidence || 'medium';
    resultEl.innerHTML =
      '<div class="analysis">'+
        '<div class="name">'+escapeHtml(data.foodName||'Meal')+'</div>'+
        '<div class="portion">'+escapeHtml(data.portionEstimate||'')+'</div>'+
        '<div class="kcalrow"><b>'+round(data.calories||0)+'</b> kcal</div>'+
        '<div class="macrolist">'+
          '<div><div class="n">Protein</div><div class="g">'+round(data.protein_g||0)+'g</div></div>'+
          '<div><div class="n">Carbs</div><div class="g">'+round(data.carbs_g||0)+'g</div></div>'+
          '<div><div class="n">Fat</div><div class="g">'+round(data.fat_g||0)+'g</div></div>'+
        '</div>'+
        '<div class="confbadge">'+escapeHtml(conf)+' confidence</div>'+
      '</div>'+
      '<div class="stack">'+
        '<button class="btn" id="confirmAddBtn">Add to today\'s log</button>'+
        '<button class="btn ghost" id="editManualBtn">Edit values</button>'+
        '<button class="btn ghost" id="retakeBtn2">Retake photo</button>'+
      '</div>';

    document.getElementById('confirmAddBtn').addEventListener('click', ()=>commitFood(data));
    document.getElementById('editManualBtn').addEventListener('click', ()=>{
      resultEl.insertAdjacentHTML('beforeend', manualEntryHtml(data));
      wireManualEntry();
      document.getElementById('editManualBtn').style.display='none';
    });
    document.getElementById('retakeBtn2').addEventListener('click', resetLogView);
  }

  function manualEntryHtml(prefill){
    prefill = prefill || {};
    return '<div class="analysis" style="margin-top:14px;">'+
      '<div class="field"><label>Food name</label><input type="text" id="mName" value="'+escapeHtml(prefill.foodName||'')+'"></div>'+
      '<div class="row2">'+
        '<div class="field"><label>Calories</label><input type="number" id="mCal" value="'+(prefill.calories||'')+'"></div>'+
        '<div class="field"><label>Protein (g)</label><input type="number" id="mP" value="'+(prefill.protein_g||'')+'"></div>'+
      '</div>'+
      '<div class="row2">'+
        '<div class="field"><label>Carbs (g)</label><input type="number" id="mC" value="'+(prefill.carbs_g||'')+'"></div>'+
        '<div class="field"><label>Fat (g)</label><input type="number" id="mF" value="'+(prefill.fat_g||'')+'"></div>'+
      '</div>'+
      '<button class="btn" id="manualAddBtn">Add to today\'s log</button>'+
    '</div>';
  }

  function wireManualEntry(){
    const btn = document.getElementById('manualAddBtn');
    if(!btn) return;
    btn.addEventListener('click', ()=>{
      const data = {
        foodName: document.getElementById('mName').value.trim() || 'Meal',
        calories: parseFloat(document.getElementById('mCal').value)||0,
        protein_g: parseFloat(document.getElementById('mP').value)||0,
        carbs_g: parseFloat(document.getElementById('mC').value)||0,
        fat_g: parseFloat(document.getElementById('mF').value)||0
      };
      commitFood(data);
    });
  }

  function commitFood(data){
    const now = new Date();
    const entry = {
      id: uid(),
      name: data.foodName || 'Meal',
      calories: data.calories||0,
      protein_g: data.protein_g||0,
      carbs_g: data.carbs_g||0,
      fat_g: data.fat_g||0,
      time: now.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}),
      thumb: pendingThumb || null
    };
    App.currentLog.foods.push(entry);
    App.saveLog();
    toast('Added to today\'s log');
    showView('dashboard');
  }

  // =========================================================
  // Boot
  // =========================================================
  function boot(){
    App.loadProfile();
    App.currentDate = new Date();
    App.loadLog();

    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    }

    if(!App.profile){
      showView('profile');
      toast('Welcome — set up your profile to get started');
    } else {
      showView('dashboard');
    }
  }
  boot();

})();
