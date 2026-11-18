// Token Radar dashboard: renders window.RADAR (written by main.ts from the same
// board the gate checks) with no fetch and no network. State lives in the URL
// query string, so every view - the board, one protocol's detail, a filtered
// board, the live anchors - is a link and a screenshot away.
//
// Views: ?segment=all|watchlist|early|live|check, ?category=<name>, ?chain=<name>,
// ?q=<text>, ?sort=implied|tvl|growth|age|signal|peer, ?detail=<slug>.

(function () {
  'use strict';
  var R = window.RADAR;
  var main = document.getElementById('board');
  if (!R || !main) return;

  var params = new URLSearchParams(location.search);
  var state = {
    segment: params.get('segment') || 'all',
    category: params.get('category') || '',
    chain: params.get('chain') || '',
    q: (params.get('q') || '').toLowerCase(),
    sort: params.get('sort') || 'implied',
    detail: params.get('detail') || '',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function moneyFull(n) {
    return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n) {
    if (n == null) return '<span class="chains">n/a</span>';
    var cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
    return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }
  function ageText(days) {
    if (days == null) return 'unknown';
    if (days >= 730) return (days / 365.25).toFixed(1) + ' yrs';
    if (days >= 30) return Math.round(days / 30.4) + ' mo';
    return days + ' d';
  }
  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort();
  }

  var categories = uniq(R.rows.map(function (r) { return r.category; }).concat(R.live.map(function (r) { return r.category; })));
  var chains = uniq(R.rows.reduce(function (a, r) { return a.concat(r.chains); }, []));

  function filteredRows() {
    var rows = R.rows.filter(function (r) {
      if (state.segment === 'watchlist' && r.tier !== 'watchlist') return false;
      if (state.segment === 'early' && r.tier !== 'early') return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(state.q) < 0) return false;
      return true;
    });
    var key = {
      implied: function (r) { return r.implied_value_usd; },
      tvl: function (r) { return r.tvl_usd; },
      growth: function (r) { return r.change_7d == null ? -1e9 : r.change_7d; },
      age: function (r) { return r.age_days == null ? -1 : r.age_days; },
      signal: function (r) { return r.signal_score; },
      peer: function (r) { return r.peer_multiple; },
    }[state.sort] || function (r) { return r.implied_value_usd; };
    return rows.sort(function (a, b) { return key(b) - key(a) || a.rank - b.rank; });
  }

  function headerHtml() {
    return (
      '<div class="masthead"><div>' +
      '<p class="eyebrow">Token Launch Radar · model ' + esc(R.model_version) + '</p>' +
      '<h1>Farm the launch <span class="thin">before it exists</span></h1>' +
      '<p class="tagline">Every protocol in the snapshot that records no token yet, ranked by what its token would be worth ' +
      'if its record stayed as it is — priced from the live tokens in its own category, with a costed farm plan for each.</p></div>' +
      '<div class="asof">Snapshot<strong>' + esc(R.as_of) + '</strong>DefiLlama protocol universe<br>sealed, never live-fetched</div></div>'
    );
  }

  function statsHtml() {
    var s = [
      [R.scanned_size, 'protocols scanned'],
      [R.watchlist_size + ' / ' + R.watchlist_size, 'watchlist covered'],
      [R.board_size, 'pre-token rows ranked'],
      [R.early_size, 'early finds below the floor'],
      ['<em>' + R.global_multiple.toFixed(3) + '×</em>', 'global peer multiple'],
      ['<em>' + money(R.total_implied_usd) + '</em>', 'total implied value'],
    ];
    return '<div class="stats">' + s.map(function (x) {
      return '<div class="stat"><div class="num">' + x[0] + '</div><div class="lab">' + x[1] + '</div></div>';
    }).join('') + '</div>';
  }

  function modelHtml() {
    var anchorRows = R.anchors.slice(0, 5).map(function (a) {
      return '<tr><td>' + esc(a.category) + '</td><td>' + a.peers + '</td><td>' + a.median_ratio.toFixed(3) + '×</td><td>÷' + a.bias_factor.toFixed(2) + '</td><td>' + a.multiple.toFixed(3) + '×</td></tr>';
    }).join('');
    return (
      '<div class="model"><div class="model-card"><h2>How the price is made — radar-3, peer-anchored, bias-corrected</h2>' +
      '<div class="formula">implied = TVL × peer multiple × growth × maturity × breadth</div>' +
      '<p><strong>Peer multiple:</strong> the median market-cap / TVL of the live tokens in the same category, shrunk toward the global median (' +
      R.global_multiple.toFixed(3) + '×); a category with fewer than four live peers is pinned near that median, so one outlier token cannot price a whole category. ' +
      '<strong>Bias correction:</strong> each category’s multiple is divided by the median error the raw multiple makes on that category’s own live tokens, priced leave-one-out — a category the market systematically pays less for than its peer median suggests is priced down before it reaches the board. The Model check view shows the full calibration. ' +
      '<strong>Growth:</strong> the 7-day TVL change, clamped to −50%…+100%, weighted 0.55. ' +
      '<strong>Maturity:</strong> years tracked with no token, up to five. <strong>Breadth:</strong> +2.5% per extra chain, up to eight. ' +
      'No name is special-cased: the same function prices every row, so a protocol that launches next month is priced the day it appears in the data.</p></div>' +
      '<div class="model-card"><h2>Live peer anchors (market’s own prices)</h2>' +
      '<table class="anchors"><tr><th>Category</th><th>Peers</th><th>Median</th><th>Bias ÷</th><th>Used</th></tr>' + anchorRows + '</table>' +
      '<p>Tokens that already trade are never ranked. They are the measuring stick, shown apart in the Live anchors view.</p></div></div>'
    );
  }

  function controlsHtml(count) {
    function tab(seg, label) {
      return '<button data-seg="' + seg + '" class="' + (state.segment === seg ? 'on' : '') + '">' + label + '</button>';
    }
    function opts(list, current, allLabel) {
      var h = '<option value="">' + allLabel + '</option>';
      list.forEach(function (v) { h += '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>'; });
      return h;
    }
    function sortOpt(v, label) { return '<option value="' + v + '"' + (state.sort === v ? ' selected' : '') + '>' + label + '</option>'; }
    return (
      '<div class="controls"><span class="tabs">' + tab('all', 'All ranked') + tab('watchlist', 'Watchlist') + tab('early', 'Early finds') + tab('live', 'Live anchors') + tab('check', 'Model check') + '</span>' +
      '<label>Category <select id="f-cat">' + opts(categories, state.category, 'All categories') + '</select></label>' +
      '<label>Chain <select id="f-chain">' + opts(chains, state.chain, 'All chains') + '</select></label>' +
      '<label>Sort <select id="f-sort">' + sortOpt('implied', 'Implied value') + sortOpt('tvl', 'TVL') + sortOpt('growth', '7d growth') + sortOpt('signal', 'Signal') + sortOpt('age', 'Age') + sortOpt('peer', 'Peer multiple') + '</select></label>' +
      '<input type="search" id="f-q" placeholder="Search name or slug…" value="' + esc(state.q) + '"></div>' +
      '<p class="count-line">Showing <strong>' + count + '</strong> ' + (state.segment === 'live' ? 'live anchor protocols whose tokens already trade' : state.segment === 'check' ? 'live protocols the model was checked against, each priced with its own figures left out' : 'protocols that record no token') +
      (state.category || state.chain || state.q ? ' — filtered' : '') + '. Click any row for its model breakdown and farm plan.</p>'
    );
  }

  function boardHtml(rows) {
    if (rows.length === 0) return '<div class="empty">No protocol matches this filter. Loosen the category, chain or search.</div>';
    var body = rows.map(function (r) {
      return (
        '<tr data-slug="' + esc(r.slug) + '"' + (state.detail === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span> <span class="pill ' + r.tier + '">' + r.tier + '</span><br><span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num">' + r.peer_multiple.toFixed(3) + '×<br><span class="pslug">' + r.peer_count + ' peers</span></td>' +
        '<td class="num implied">' + money(r.implied_value_usd) + '</td>' +
        '<td class="num"><span class="sig"><span class="sigbar"><i style="width:' + r.signal_score + '%"></i></span>' + r.signal_score + '</span></td></tr>'
      );
    }).join('');
    return (
      '<table class="board"><thead><tr><th>#</th><th>Protocol</th><th>Category</th><th>Chains</th>' +
      '<th class="num">TVL</th><th class="num">7d</th><th class="num">No-token age</th><th class="num">Peer mult</th>' +
      '<th class="num">Implied value</th><th class="num">Signal</th></tr></thead><tbody>' + body + '</tbody></table>'
    );
  }

  function liveHtml() {
    var body = R.live.map(function (r, i) {
      return (
        '<tr><td class="rank">' + (i + 1) + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span> <span class="pill live">live token</span><br><span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num implied">' + money(r.mcap_usd) + '</td>' +
        '<td class="num">' + (r.ratio == null ? '—' : r.ratio.toFixed(3) + '×') + '</td></tr>'
      );
    }).join('');
    return (
      '<table class="board"><thead><tr><th>#</th><th>Protocol</th><th>Category</th><th>Chains</th>' +
      '<th class="num">TVL</th><th class="num">7d</th><th class="num">Market cap (actual)</th><th class="num">Mcap / TVL</th></tr></thead><tbody>' +
      body + '</tbody></table>' +
      '<p class="note">These protocols already have a token: the market has priced them, so the radar never ranks them. Their median market-cap / TVL per category is the anchor that prices the pre-token board.</p>'
    );
  }

  function checkHtml() {
    var v = R.validation;
    var catRows = v.categories.map(function (c) {
      return '<tr><td>' + esc(c.category) + '</td><td>' + c.n + '</td><td>' + c.median_ratio.toFixed(2) + '×</td><td>' + c.within_2x_pct + '%</td></tr>';
    }).join('');
    function caseList(list) {
      return list.map(function (c) {
        return (
          '<li><span class="body"><strong>' + esc(c.name) + '</strong> <span class="pslug">' + esc(c.category || '') + '</span>' +
          '<span class="chips"><span class="chip">Model <b>' + moneyFull(c.predicted_usd) + '</b></span>' +
          '<span class="chip">Market <b>' + moneyFull(c.actual_usd) + '</b></span>' +
          '<span class="chip">Ratio <b>' + c.ratio.toFixed(2) + '×</b></span></span></span></li>'
        );
      }).join('');
    }
    return (
      '<section class="detail"><h2>The model, checked against the market</h2>' +
      '<p>Every live-token protocol in the snapshot (' + v.n + ' of them) was priced by the same formula that prices the board, with its own market-cap / TVL left out of its peer anchor and its own pricing error left out of its category’s bias correction. ' +
      'The median predicted / actual market cap is <strong>' + v.median_ratio.toFixed(2) + '×</strong>: at the median the model is calibrated — it does not systematically overprice or underprice what the market pays.</p>' +
      '<p>Individual protocols still disperse widely around their category’s price — the typical miss is about ×' + Math.exp(v.median_abs_log_error).toFixed(1) +
      ', because one token’s market cap depends on far more than its TVL. That dispersion is why the board prices by category rather than by any single comparable, and why every farm plan on this page sizes its position small enough to lose.</p>' +
      '<div class="detail-grid"><div><h3>Calibration by category</h3>' +
      '<table class="anchors"><tr><th>Category</th><th>Checked</th><th>Median ratio</th><th>Within 2×</th></tr>' + catRows + '</table>' +
      '<p class="note">Categories with fewer than four checked protocols are left out of this table; their board prices lean on the global median instead.</p></div>' +
      '<div><h3>Closest calls</h3><ol class="plan">' + caseList(v.closest) + '</ol>' +
      '<h3>Widest misses, kept in view</h3><ol class="plan">' + caseList(v.furthest) + '</ol></div></div></section>'
    );
  }

  function splitStep(step) {
    var m = /^(.*) Cost: (.*)\. Time: (.*)\.$/.exec(step);
    if (!m) return { text: step, cost: '', time: '' };
    return { text: m[1], cost: m[2], time: m[3] };
  }

  function multBar(label, value, max, cls, note) {
    var w = Math.max(3, Math.min(100, (value / max) * 100));
    return (
      '<div class="mult"><div class="row"><span>' + label + '</span><span>' + value.toFixed(3) + '× ' + note + '</span></div>' +
      '<div class="bar"><i class="' + (cls || '') + '" style="width:' + w + '%"></i></div></div>'
    );
  }

  function detailHtml(r) {
    var plan = r.farm_steps.map(function (s, i) {
      var p = splitStep(s);
      return (
        '<li><span class="n">' + (i + 1) + '</span><span class="body">' + esc(p.text) +
        '<span class="chips"><span class="chip">Cost <b>' + esc(p.cost) + '</b></span><span class="chip">Time <b>' + esc(p.time) + '</b></span></span></span></li>'
      );
    }).join('');
    return (
      '<section class="detail"><div class="detail-head"><div><h2>' + esc(r.name) + ' <span class="pill ' + r.tier + '">' + r.tier + '</span></h2>' +
      '<div class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ') || 'no chains recorded') + ' · rank #' + r.rank + ' of ' + R.board_size + '</div></div>' +
      '<div class="big-implied"><div class="v">' + moneyFull(r.implied_value_usd) + '</div><div class="l">Implied value if it launched today</div></div></div>' +
      '<div class="detail-grid"><div><h3>The price, step by step</h3>' +
      multBar('TVL base', 1, 1.6, '', moneyFull(r.tvl_usd) + ' of TVL') +
      multBar('Peer multiple', r.peer_multiple, 1.6, 'g', r.peer_count + ' live peers in ' + esc(r.category || 'its category')) +
      multBar('Growth (7d)', r.growth_multiplier, 1.6, '', (r.change_7d == null ? 'unreported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '% TVL')) +
      multBar('Maturity', r.maturity_multiplier, 1.6, '', ageText(r.age_days) + ' with no token recorded') +
      multBar('Breadth', r.breadth_multiplier, 1.6, '', r.chains.length + (r.chains.length === 1 ? ' chain' : ' chains')) +
      '<dl class="facts">' +
      '<dt>TVL</dt><dd>' + moneyFull(r.tvl_usd) + '</dd>' +
      '<dt>7-day change</dt><dd>' + (r.change_7d == null ? 'unreported' : r.change_7d.toFixed(2) + '%') + '</dd>' +
      '<dt>Tracked since</dt><dd>' + esc(r.listed_at || 'unknown') + '</dd>' +
      '<dt>Bias correction</dt><dd>÷' + r.bias_factor.toFixed(2) + ' — the median error of the raw peer multiple on this category’s live tokens</dd>' +
      '<dt>Signal score</dt><dd>' + r.signal_score + ' / 100</dd>' +
      '<dt>Token status</dt><dd>records no token</dd>' +
      '<dt>Board tier</dt><dd>' + (r.tier === 'watchlist' ? 'Watchlist (≥ $50M TVL)' : 'Early find (below the $50M floor)') + '</dd></dl>' +
      '<p class="note">“Records no token” is DefiLlama’s record, not proof: the board prices what a launch would be worth on today’s figures and never predicts that a launch will happen.</p></div>' +
      '<div><h3>Farm plan — ' + r.farm_steps.length + ' steps, costed</h3>' +
      '<p class="chips"><span class="chip">Capital <b>$' + r.plan.capital_usd + '</b></span>' +
      '<span class="chip">Est. gas <b>$' + r.plan.est_gas_usd + '</b></span>' +
      '<span class="chip">Hold <b>' + r.plan.hold_days + ' days · ' + r.plan.weeks + ' weekly actions</b></span></p>' +
      '<p class="note">' + esc(r.plan.risk) + '</p>' +
      '<ol class="plan">' + plan + '</ol></div></div></section>'
    );
  }

  function footerHtml() {
    return (
      '<footer>Source: ' + esc(R.source) + '. The board is regenerated from the sealed snapshot on every run of the program — ' +
      'run it on a fresher snapshot and protocols that do not exist yet are priced by the same peer-anchored model, with no hand-kept list anywhere in the code. ' +
      'Implied values are this entry’s own model claims, not make.fun’s, and not financial advice.</footer>'
    );
  }

  function render() {
    var html = headerHtml() + statsHtml() + modelHtml();
    if (state.segment === 'live') {
      html += controlsHtml(R.live.length) + liveHtml();
    } else if (state.segment === 'check') {
      html += controlsHtml(R.validation.n) + checkHtml();
    } else {
      var rows = filteredRows();
      var detail = R.rows.filter(function (r) { return r.slug === state.detail; })[0];
      // A selected protocol leads the page: its breakdown and plan sit above the
      // board, so the detail view is the first thing a reader (or a screenshot)
      // meets, and the board stays one scroll below for context.
      if (detail) html += detailHtml(detail);
      html += controlsHtml(rows.length) + boardHtml(rows);
    }
    html += footerHtml();
    main.innerHTML = html;
    main.setAttribute('aria-busy', 'false');
    wire();
    if (state.detail && state.segment !== 'live') {
      var el = document.querySelector('.detail');
      if (el && params.get('detail')) el.scrollIntoView();
    }
  }

  function push() {
    var p = new URLSearchParams();
    if (state.segment !== 'all') p.set('segment', state.segment);
    if (state.category) p.set('category', state.category);
    if (state.chain) p.set('chain', state.chain);
    if (state.q) p.set('q', state.q);
    if (state.sort !== 'implied') p.set('sort', state.sort);
    if (state.detail) p.set('detail', state.detail);
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : ''));
  }

  function wire() {
    var tabs = document.querySelectorAll('.tabs button');
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener('click', function () {
      state.segment = this.getAttribute('data-seg'); push(); render();
    });
    var cat = document.getElementById('f-cat');
    if (cat) cat.addEventListener('change', function () { state.category = this.value; push(); render(); });
    var ch = document.getElementById('f-chain');
    if (ch) ch.addEventListener('change', function () { state.chain = this.value; push(); render(); });
    var so = document.getElementById('f-sort');
    if (so) so.addEventListener('change', function () { state.sort = this.value; push(); render(); });
    var q = document.getElementById('f-q');
    if (q) q.addEventListener('input', function () { state.q = this.value.toLowerCase(); push(); renderSoft(); });
    var trs = document.querySelectorAll('.board tbody tr[data-slug]');
    for (var j = 0; j < trs.length; j++) trs[j].addEventListener('click', function () {
      state.detail = this.getAttribute('data-slug'); push(); render();
      var el = document.querySelector('.detail');
      if (el) el.scrollIntoView({ block: 'start' });
    });
  }

  // Re-render only the table on search typing, so the input keeps focus.
  function renderSoft() {
    render();
    var q = document.getElementById('f-q');
    if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  render();
})();
