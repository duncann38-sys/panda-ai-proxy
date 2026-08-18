<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex,nofollow" />
<title>Panda — Users</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root{
    --bg:#050b08; --bg2:#0a1712; --surf:#0e1e17; --surf2:#122a20;
    --line:#1c3428; --text:#eaf3ee; --muted:#8fa89b; --faint:#5f776b;
    --green:#2E9E63; --green2:#57c98a; --gold:#C6A15B; --gold2:#E4C77E; --goldsoft:rgba(198,161,91,.14);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:radial-gradient(1200px 600px at 50% -10%,#0c231a 0%,var(--bg) 60%);color:var(--text);
    font-family:'Inter',system-ui,sans-serif;min-height:100vh;padding:40px 20px;line-height:1.5}
  .wrap{max-width:840px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .mark{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#0f3625,#08402a);
    display:grid;place-items:center;box-shadow:inset 0 0 0 1px var(--line)}
  .mark svg{width:22px;height:22px}
  .brand b{font-family:'Space Grotesk';font-weight:700;font-size:20px}
  .brand span{color:var(--gold);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
  h1{font-family:'Space Grotesk';font-weight:700;font-size:30px;margin:22px 0 4px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:26px}
  /* gate */
  .gate{max-width:380px;margin:60px auto;background:var(--surf);border:1px solid var(--line);border-radius:18px;padding:26px}
  .gate h2{font-family:'Space Grotesk';font-size:18px;margin-bottom:4px}
  .gate p{color:var(--muted);font-size:13px;margin-bottom:16px}
  input{width:100%;background:var(--bg2);border:1.5px solid var(--line);border-radius:12px;padding:13px 14px;
    color:var(--text);font-size:15px;font-family:inherit;outline:none;transition:.15s}
  input:focus{border-color:var(--gold);box-shadow:0 0 0 3px var(--goldsoft)}
  .btn{width:100%;margin-top:12px;background:linear-gradient(135deg,var(--gold),#b38f4c);color:#241a06;
    border:none;border-radius:12px;padding:13px;font-weight:700;font-size:15px;font-family:'Space Grotesk';cursor:pointer;transition:.15s}
  .btn:hover{filter:brightness(1.06)}
  .err{color:#ff9a8f;font-size:13px;margin-top:10px;min-height:18px}
  /* stats */
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}
  .card{background:var(--surf);border:1px solid var(--line);border-radius:16px;padding:20px}
  .card .k{color:var(--muted);font-size:12.5px;font-weight:600;margin-bottom:10px;display:flex;align-items:center;gap:7px}
  .card .k svg{width:15px;height:15px;color:var(--gold)}
  .card .v{font-family:'Space Grotesk';font-weight:700;font-size:38px;letter-spacing:-.02em;line-height:1}
  .card.hero{grid-column:span 3;background:linear-gradient(135deg,#0d2c1e,#0a1e15);border-color:var(--gold)}
  .card.hero .v{font-size:56px;color:var(--gold2)}
  .panel{background:var(--surf);border:1px solid var(--line);border-radius:16px;padding:22px;margin-top:4px}
  .panel h3{font-family:'Space Grotesk';font-size:15px;margin-bottom:2px}
  .panel .sub2{color:var(--muted);font-size:12.5px;margin-bottom:18px}
  .bars{display:flex;align-items:flex-end;gap:6px;height:150px}
  .bar{flex:1;background:linear-gradient(180deg,var(--green2),var(--green));border-radius:6px 6px 3px 3px;
    min-height:3px;position:relative;transition:.3s}
  .bar span{position:absolute;bottom:-20px;left:0;right:0;text-align:center;color:var(--faint);font-size:9px;white-space:nowrap}
  .bar b{position:absolute;top:-18px;left:0;right:0;text-align:center;color:var(--muted);font-size:10px;font-weight:600}
  .foot{color:var(--faint);font-size:12px;margin-top:22px;text-align:center}
  .top{display:flex;justify-content:space-between;align-items:flex-start}
  .refresh{background:var(--surf2);border:1px solid var(--line);color:var(--muted);border-radius:10px;
    padding:8px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
  .refresh:hover{color:var(--text)}
  @media (max-width:560px){.grid{grid-template-columns:1fr}.card.hero{grid-column:span 1}.card.hero .v{font-size:44px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><div class="mark"><svg viewBox="0 0 40 40" fill="none"><circle cx="12" cy="13" r="6" fill="#08321f"/><circle cx="28" cy="13" r="6" fill="#08321f"/><circle cx="20" cy="21" r="13" fill="#fff"/><ellipse cx="14" cy="18" rx="3" ry="4" fill="#08321f"/><ellipse cx="26" cy="18" rx="3" ry="4" fill="#08321f"/><circle cx="14" cy="17" r="1" fill="#fff"/><circle cx="26" cy="17" r="1" fill="#fff"/><ellipse cx="20" cy="25" rx="2.4" ry="1.8" fill="#08321f"/></svg></div>
    <div><b>Panda</b> <span>Internal</span></div>
  </div>

  <!-- Gate -->
  <div class="gate" id="gate">
    <h2>Users dashboard</h2>
    <p>Enter the access key to view app user numbers.</p>
    <input id="keyInput" type="password" placeholder="Access key" autocomplete="off" />
    <button class="btn" id="enterBtn">View numbers</button>
    <div class="err" id="err"></div>
  </div>

  <!-- Stats -->
  <div id="stats" style="display:none">
    <div class="top"><div><h1>How many people have Panda</h1><div class="sub">Unique users and active users, counted from anonymous app opens.</div></div>
      <button class="refresh" id="refreshBtn">Refresh</button></div>
    <div class="grid">
      <div class="card hero"><div class="k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Total users (all time)</div><div class="v" id="mTotal">—</div></div>
      <div class="card"><div class="k">Active today</div><div class="v" id="mDay">—</div></div>
      <div class="card"><div class="k">Active this week</div><div class="v" id="mWeek">—</div></div>
      <div class="card"><div class="k">Active (30 days)</div><div class="v" id="mMonth">—</div></div>
    </div>
    <div class="panel"><h3>Daily active users</h3><div class="sub2">Unique people who opened the app each day (last 14 days).</div>
      <div class="bars" id="bars"></div><div style="height:22px"></div></div>
    <div class="foot" id="foot"></div>
  </div>
</div>

<script>
  // Point this at your deployed backend:
  var STATS_ENDPOINT = "https://panda-partners-api.vercel.app/api/stats";
  var $ = function(s){ return document.querySelector(s); };

  function show(el,on){ el.style.display = on ? "" : "none"; }

  function load(key){
    $("#err").textContent = "Loading…";
    fetch(STATS_ENDPOINT + "?key=" + encodeURIComponent(key))
      .then(function(r){ if(r.status===401) throw new Error("Wrong access key."); if(!r.ok) throw new Error("Couldn't load (" + r.status + ")."); return r.json(); })
      .then(function(d){
        try{ localStorage.setItem("panda_stats_key", key); }catch(e){}
        show($("#gate"), false); show($("#stats"), true);
        $("#mTotal").textContent = (d.total||0).toLocaleString();
        $("#mDay").textContent   = (d.activeToday||0).toLocaleString();
        $("#mWeek").textContent  = (d.activeWeek||0).toLocaleString();
        $("#mMonth").textContent = (d.active30d||0).toLocaleString();
        var daily = d.daily || [];
        var max = Math.max(1, ...daily.map(function(x){ return x.users; }));
        $("#bars").innerHTML = daily.map(function(x){
          var lab = x.date.slice(5); // MM-DD
          return '<div class="bar" style="height:' + (x.users/max*100) + '%"><b>' + (x.users||"") + '</b><span>' + lab + '</span></div>';
        }).join("") || '<div style="color:var(--faint);font-size:13px">No opens yet — numbers start counting once the app fires app_open events.</div>';
        $("#foot").textContent = "Counts anonymous device IDs. Not retroactive — begins from when tracking was added. Updated " + new Date().toLocaleString();
      })
      .catch(function(e){ $("#err").textContent = e.message; show($("#gate"), true); show($("#stats"), false); });
  }

  $("#enterBtn").addEventListener("click", function(){ var k=$("#keyInput").value.trim(); if(k) load(k); });
  $("#keyInput").addEventListener("keydown", function(e){ if(e.key==="Enter"){ var k=$("#keyInput").value.trim(); if(k) load(k); } });
  $("#refreshBtn").addEventListener("click", function(){ var k = localStorage.getItem("panda_stats_key"); if(k) load(k); });

  // auto-load if we already have a key saved
  (function(){ var k; try{ k = localStorage.getItem("panda_stats_key"); }catch(e){} if(k) load(k); })();
</script>
</body>
</html>
