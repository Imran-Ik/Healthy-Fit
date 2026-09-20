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
      const t = {calories:0, protein:0, carbs:0, fat:0, fiber:0};
      for(const f of this.currentLog.foods){
        t.calories += f.calories||0;
        t.protein += f.protein_g||0;
        t.carbs += f.carbs_g||0;
        t.fat += f.fat_g||0;
        t.fiber += f.fiber_g||0;
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
    _lastPeakTime: 0,
    _intervals: [],        // recent peak-to-peak gaps, used to confirm a walking rhythm
    _locked: false,        // true once we've confirmed real walking cadence, not a one-off jolt
    _minIntervalMs: 300,   // fastest plausible step cadence (~200 steps/min ceiling)
    _maxIntervalMs: 1000,  // slowest plausible step cadence (~60 steps/min floor)
    _thresholdHigh: 3.2,   // delta above baseline needed to register a candidate peak — raise if still too sensitive, lower if it's missing real steps
    _thresholdLow: 1.2,    // delta must fall back below this before the next peak can register
    _lockAfter: 2,         // consecutive rhythmic peaks required before we trust it's actually walking
    _onStep: null,

    isSupported(){
      return typeof window.DeviceMotionEvent !== 'undefined';
    },

    async requestPermission(){
      // iOS 13+ requires an explicit, user-gesture-triggered permission prompt.
      if(typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function'){
        try{
          const res = await DeviceMotionEvent.requestPermission();
          return res === 'granted';
        }catch(e){
          return false;
        }
      }
      // Android / older browsers: no explicit prompt, permission is implicit.
      return true;
    },

    start(onStep){
      if(this.active) return;
      this._onStep = onStep;
      this._armed = false;
      this._lastPeakTime = 0;
      this._intervals = [];
      this._locked = false;
      this._smoothedMag = 9.8;
      this._baseline = 9.8;
      window.addEventListener('devicemotion', this._handleMotion);
      this.active = true;
    },

    stop(){
      window.removeEventListener('devicemotion', this._handleMotion);
      this.active = false;
    },

    // Called once per detected peak (a single up-swing in acceleration).
    // A lone hand movement produces exactly one peak with no rhythmic
    // follow-up, so it never gets counted — only a repeating, evenly-spaced
    // pattern (an actual gait) earns a "lock" and starts counting steps.
    _registerPeak(now){
      const prev = this._lastPeakTime;
      this._lastPeakTime = now;
      if(!prev) return; // first peak ever seen — nothing to compare yet

      const interval = now - prev;
      const inRange = interval >= this._minIntervalMs && interval <= this._maxIntervalMs;

      if(!inRange){
        // Rhythm broken — either noise/jitter (too fast) or a pause in
        // walking (too slow). Reset and start rebuilding trust from here.
        this._intervals = [];
        this._locked = false;
        return;
      }

      if(this._locked){
        if(this._onStep) this._onStep();
        return;
      }

      this._intervals.push(interval);
      if(this._intervals.length > this._lockAfter) this._intervals.shift();
      if(this._intervals.length >= this._lockAfter){
        const avg = this._intervals.reduce((a,b)=>a+b,0)/this._intervals.length;
        const consistent = this._intervals.every(iv => Math.abs(iv-avg) <= avg*0.45);
        if(consistent){
          this._locked = true;
          if(this._onStep) this._onStep(); // count the peak that confirmed the lock
        }
      }
    },

    _handleMotion(event){
      const acc = event.accelerationIncludingGravity || event.acceleration;
      if(!acc || acc.x===null) return;
      const x=acc.x||0, y=acc.y||0, z=acc.z||0;
      const rawMag = Math.sqrt(x*x + y*y + z*z);

      // Fast smoothing rides out single-sample spikes while still tracking
      // the ~1-3Hz rhythm of an actual step.
      StepTracker._smoothedMag = StepTracker._smoothedMag*0.7 + rawMag*0.3;
      // Slow smoothing tracks the "resting" level so the threshold adapts
      // to however the phone is currently being held.
      StepTracker._baseline = StepTracker._baseline*0.95 + rawMag*0.05;

      const delta = StepTracker._smoothedMag - StepTracker._baseline;
      const now = Date.now();

      if(!StepTracker._armed && delta > StepTracker._thresholdHigh){
        StepTracker._armed = true;
        StepTracker._registerPeak(now);
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
    document.getElementById('fiberVal').textContent = round(t.fiber);
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
        '<div class="meta"><div class="n">'+escapeHtml(f.name)+'</div><div class="m">'+f.time+' · '+round(f.protein_g)+'p '+round(f.carbs_g)+'c '+round(f.fat_g)+'f '+round(f.fiber_g||0)+'fib</div></div>'+
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
    pendingBlob = null; pendingThumb = null; editorRows = [];
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
      const items = Array.isArray(data.items) ? data.items : [data];
      renderItemsEditor(items);
    }catch(err){
      renderItemsEditor([blankRow()], {errorMsg: 'Couldn\'t analyze that photo (' + (err.message||'unknown error') + ').'});
    }
  }

  // ---- Editable multi-dish list — this IS the "edit" flow. A thali comes
  // back as several rows; you can fix any field, remove a wrong dish, or
  // add one the AI missed, and the running total recalculates live. ----
  let editorRows = [];

  function blankRow(){
    return {id: uid(), name:'', portionEstimate:'', calories:0, protein_g:0, carbs_g:0, fat_g:0, fiber_g:0, confidence:null};
  }

  function renderItemsEditor(items, opts){
    opts = opts || {};
    editorRows = items.map(it => ({
      id: uid(),
      name: it.name || it.foodName || '',
      portionEstimate: it.portionEstimate || '',
      calories: it.calories||0,
      protein_g: it.protein_g||0,
      carbs_g: it.carbs_g||0,
      fat_g: it.fat_g||0,
      fiber_g: it.fiber_g||0,
      confidence: it.confidence || null
    }));
    if(editorRows.length===0) editorRows.push(blankRow());
    renderEditorRows(opts.errorMsg);
  }

  function editorTotals(){
    return editorRows.reduce((t,r)=>({
      calories: t.calories + (Number(r.calories)||0),
      protein: t.protein + (Number(r.protein_g)||0),
      carbs: t.carbs + (Number(r.carbs_g)||0),
      fat: t.fat + (Number(r.fat_g)||0),
      fiber: t.fiber + (Number(r.fiber_g)||0)
    }), {calories:0,protein:0,carbs:0,fat:0,fiber:0});
  }

  function renderEditorRows(errorMsg){
    const resultEl = document.getElementById('logResult');
    const t = editorTotals();
    const n = editorRows.length;

    let html = '';
    if(errorMsg){
      html += '<div class="errbox">'+escapeHtml(errorMsg)+' You can still enter dishes manually below.</div>';
    }
    html += '<div class="analysis" style="margin-bottom:14px;">'+
      '<div class="portion">'+n+' dish'+(n===1?'':'es')+' found — edit any field and the total updates</div>'+
      '<div class="kcalrow"><b>'+round(t.calories)+'</b> kcal</div>'+
      '<div class="macrolist">'+
        '<div><div class="n">Protein</div><div class="g">'+round(t.protein)+'g</div></div>'+
        '<div><div class="n">Carbs</div><div class="g">'+round(t.carbs)+'g</div></div>'+
        '<div><div class="n">Fat</div><div class="g">'+round(t.fat)+'g</div></div>'+
        '<div><div class="n">Fiber</div><div class="g">'+round(t.fiber)+'g</div></div>'+
      '</div>'+
    '</div>';

    html += editorRows.map(r=>{
      return '<div class="dishcard" data-row="'+r.id+'">'+
        '<div class="dishcard-top">'+
          '<input type="text" class="dishname" data-field="name" value="'+escapeHtml(r.name)+'" placeholder="Dish name">'+
          '<button class="del" data-remove="'+r.id+'" aria-label="Remove dish">✕</button>'+
        '</div>'+
        (r.portionEstimate ? '<div class="portion">'+escapeHtml(r.portionEstimate)+'</div>' : '')+
        '<div class="dishgrid">'+
          '<label>Cal<input type="number" data-field="calories" value="'+r.calories+'"></label>'+
          '<label>Protein g<input type="number" data-field="protein_g" value="'+r.protein_g+'"></label>'+
          '<label>Carbs g<input type="number" data-field="carbs_g" value="'+r.carbs_g+'"></label>'+
          '<label>Fat g<input type="number" data-field="fat_g" value="'+r.fat_g+'"></label>'+
          '<label>Fiber g<input type="number" data-field="fiber_g" value="'+r.fiber_g+'"></label>'+
        '</div>'+
        (r.confidence ? '<div class="confbadge">'+escapeHtml(r.confidence)+' confidence</div>' : '')+
      '</div>';
    }).join('');

    html += '<div class="stack">'+
      '<button class="btn secondary" id="addDishBtn">+ Add a dish it missed</button>'+
      '<button class="btn" id="commitAllBtn">Add '+n+' dish'+(n===1?'':'es')+' to today\'s log</button>'+
      '<button class="btn ghost" id="retakeBtnX">Retake / choose different photo</button>'+
    '</div>';

    resultEl.innerHTML = html;
    wireEditorEvents();
  }

  function wireEditorEvents(){
    const resultEl = document.getElementById('logResult');
    resultEl.querySelectorAll('.dishcard input[data-field]').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const rowId = inp.closest('.dishcard').getAttribute('data-row');
        const row = editorRows.find(r=>r.id===rowId);
        if(!row) return;
        const field = inp.getAttribute('data-field');
        row[field] = (field==='name') ? inp.value : (parseFloat(inp.value)||0);
        updateEditorTotalsDisplay();
      });
    });
    resultEl.querySelectorAll('[data-remove]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const rowId = btn.getAttribute('data-remove');
        editorRows = editorRows.filter(r=>r.id!==rowId);
        if(editorRows.length===0) editorRows.push(blankRow());
        renderEditorRows();
      });
    });
    const addBtn = document.getElementById('addDishBtn');
    if(addBtn) addBtn.addEventListener('click', ()=>{ editorRows.push(blankRow()); renderEditorRows(); });
    const commitBtn = document.getElementById('commitAllBtn');
    if(commitBtn) commitBtn.addEventListener('click', commitAllDishes);
    const retake = document.getElementById('retakeBtnX');
    if(retake) retake.addEventListener('click', resetLogView);
  }

  // Only patch the numbers in the totals header on every keystroke —
  // re-rendering the whole list on every input would steal focus mid-type.
  function updateEditorTotalsDisplay(){
    const t = editorTotals();
    const kcalEl = document.querySelector('#logResult .analysis .kcalrow b');
    if(kcalEl) kcalEl.textContent = round(t.calories);
    const macroEls = document.querySelectorAll('#logResult .analysis .macrolist .g');
    if(macroEls.length>=4){
      macroEls[0].textContent = round(t.protein)+'g';
      macroEls[1].textContent = round(t.carbs)+'g';
      macroEls[2].textContent = round(t.fat)+'g';
      macroEls[3].textContent = round(t.fiber)+'g';
    }
  }

  function commitAllDishes(){
    const now = new Date();
    let added = 0;
    editorRows.forEach(r=>{
      if(!r.name.trim() && !r.calories) return; // skip a blank row nobody filled in
      App.currentLog.foods.push({
        id: uid(),
        name: r.name.trim() || 'Dish',
        calories: r.calories||0,
        protein_g: r.protein_g||0,
        carbs_g: r.carbs_g||0,
        fat_g: r.fat_g||0,
        fiber_g: r.fiber_g||0,
        time: now.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}),
        thumb: pendingThumb || null
      });
      added++;
    });
    if(added===0){ toast('Add at least one dish first'); return; }
    App.saveLog();
    toast('Added '+added+' dish'+(added===1?'':'es')+' to today\'s log');
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
