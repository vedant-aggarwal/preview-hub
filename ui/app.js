(function () {
  'use strict';
  var state = null, filterText = '', editing = null, logId = null, timer = null, menuTrigger = null;
  var $ = function (id) { return document.getElementById(id); };
  var narrow = window.matchMedia('(max-width: 639px)');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function dur(ms) {
    if (ms == null) return '';
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return d + 'd ' + (h % 24) + 'h';
    if (h >= 1) return h + 'h ' + (m % 60) + 'm';
    if (m >= 1) return m + 'm';
    return 'under a minute';
  }
  // compact duration for rows: 25m, 3h 12m, 6d 23h, <1m
  function short(ms) {
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return d + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
    if (h >= 1) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    if (m >= 1) return m + 'm';
    return '<1m';
  }
  function ago(ms) {
    var m = Math.floor(Math.max(0, ms) / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (m < 1) return 'just now';
    if (h < 1) return m + 'm ago';
    if (d < 1) return h + 'h ago';
    return d + 'd ago';
  }
  function ttlLabel(ms) {
    if (!ms) return 'never';
    var map = { 3600000: '1h', 14400000: '4h', 43200000: '12h', 86400000: '1d', 259200000: '3d', 604800000: '7d', 2592000000: '30d' };
    return map[ms] || null;
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function hostOf(u) { try { return new URL(u).host; } catch (e) { return u || ''; } }
  function lastSeg(p) { var parts = String(p || '').split(/[\\/]/).filter(Boolean); return parts[parts.length - 1] || String(p || ''); }
  function shortPath(p) {
    var s = String(p || ''), parts = s.split(/[\\/]/).filter(Boolean);
    if (s.length <= 46 || parts.length < 4) return s;
    var sep = s.indexOf('\\') >= 0 ? '\\' : '/';
    return parts[0] + sep + '…' + sep + parts.slice(-2).join(sep);
  }

  var ICON = {
    more: '<circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/>',
    play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z"/>',
    open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
    share: '<path d="M12 3.5v11"/><path d="M8 7.5l4-4 4 4"/><path d="M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8 8"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5V9h4.5"/>',
    logs: '<path d="M5 7.5l4 4.5-4 4.5"/><path d="M12.5 17H19"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    server: '<rect x="3.5" y="4.5" width="17" height="6.5" rx="2"/><rect x="3.5" y="13" width="17" height="6.5" rx="2"/><path d="M7.5 7.75h.01M7.5 16.25h.01"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
    video: '<rect x="3.5" y="6" width="12.5" height="12" rx="2.5"/><path d="M16 10.5l4.5-2.7v8.4L16 13.5"/>',
    music: '<path d="M9 18V6l10.5-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17" cy="16" r="2.5"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/>'
  };
  function icon(name, filled, cls) {
    return '<svg class="' + (filled ? 'f' : 'i') + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + '</svg>';
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { 'x-hub': '1' }, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/_hub/api/' + path, opts).then(function (r) {
      if (r.status === 401) { location.href = '/_hub/login'; throw new Error('login'); }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  }

  function showAlert(msg) {
    var a = $('alert');
    a.innerHTML = icon('alert') + '<span>' + esc(msg) + '</span>';
    a.hidden = false;
  }

  var lastSig = '', lastRender = 0;
  function load(force) {
    return api('GET', 'state').then(function (s) {
      state = s;
      if (!$('alert').hidden) $('alert').hidden = true;
      var sig = JSON.stringify([s.hub.tunnel.status, s.previews.map(function (p) { return [p.id, p.status, p.name, p.shotAt, p.expiresAt, p.stoppedAt, p.private, p.target, p.cmd]; })]);
      if (force === true || sig !== lastSig || Date.now() - lastRender > 30000) { lastSig = sig; lastRender = Date.now(); render(); }
    }).catch(function (e) {
      if (e.message !== 'login') showAlert('Hub unreachable: ' + e.message + '. Retrying every few seconds.');
    });
  }

  function targetPort(p) {
    if (!p.target) return '';
    try { var u = new URL(p.target); return u.port || '80'; } catch (e) { return ''; }
  }
  function fileKind(p) {
    var ext = (lastSeg(p.path).match(/\.([a-z0-9]{1,5})$/i) || [])[1];
    if (!ext) return 'folder';
    ext = ext.toLowerCase();
    if (/^(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/.test(ext)) return 'image';
    if (/^(mp4|m4v|webm|mov|mkv)$/.test(ext)) return 'video';
    if (/^(mp3|wav|m4a|ogg|opus|flac|aac)$/.test(ext)) return 'audio';
    if (ext === 'pdf') return 'pdf';
    if (/^html?$/.test(ext)) return 'page';
    return ext;
  }
  function kindLabel(p) {
    if (p.kind !== 'static') {
      var port = targetPort(p);
      return (p.managed ? 'Server' : 'Attached server') + (port ? ' :' + port : p.managed ? ', port not found yet' : '');
    }
    var k = fileKind(p);
    return { folder: 'Folder', image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', page: 'Page' }[k] || (k.toUpperCase() + ' file');
  }
  function kindIcon(p) {
    if (p.kind !== 'static') return 'server';
    return { folder: 'folder', image: 'image', video: 'video', audio: 'music' }[fileKind(p)] || 'file';
  }
  function metaText(p) {
    var bits = [kindLabel(p)];
    if (p.status === 'down' && !p.canStart) bits.push('no start command');
    if (p.by) bits.push('by ' + p.by);
    if (p.hits) bits.push(p.hits + (p.hits === 1 ? ' visit' : ' visits'));
    return bits.join(', ');
  }
  function stateText(p) {
    if (p.status === 'stopped') return (p.stopReason === 'expired' ? 'Expired ' : 'Stopped ') + ago(Date.now() - p.stoppedAt);
    return { live: 'Live', starting: 'Starting…', down: 'Not answering' }[p.status] || p.status;
  }

  function thumb(p) {
    var inner = p.shotAt
      ? '<img loading="lazy" decoding="async" alt="" src="/_hub/shot/' + encodeURIComponent(p.id) + '.jpg?v=' + p.shotAt + '">'
      : '<span class="ph">' + icon(kindIcon(p)) + '</span>';
    return '<span class="thumb" aria-hidden="true">' + inner + '</span>';
  }

  function timeSlot(p) {
    if (p.expiresIn == null) return '<span class="slot"><span class="ttl">No expiry</span></span>';
    var soon = p.expiresIn < 15 * 60000;
    var on = p.ttl ? Math.max(1, Math.min(8, Math.ceil(8 * p.expiresIn / p.ttl))) : 8;
    var segs = '';
    for (var i = 0; i < 8; i++) segs += i < on ? '<i class="on"></i>' : '<i></i>';
    return '<span class="slot"><span class="ttl' + (soon ? ' soon' : '') + '">' + short(p.expiresIn) + ' left</span>' +
      '<span class="meter' + (soon ? ' soon' : '') + '" aria-hidden="true">' + segs + '</span></span>';
  }

  function row(p) {
    var st = p.status, idq = esc(p.id), slot = '';
    if (st === 'live') slot = timeSlot(p);
    else if ((st === 'stopped' || st === 'down') && p.canStart) {
      slot = '<span class="slot"><button class="go" data-act="start" data-id="' + idq + '">' + icon('play', true) + 'Start</button></span>';
    }
    return '<article class="row is-' + st + '">' + thumb(p) +
      '<div class="body">' +
        '<h3 class="row-name"><a class="row-link" href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a>' +
          (p.private ? '<span class="sr">, private</span>' + icon('lock', false, 'lock') : '') + '</h3>' +
        '<div class="row-status"><span class="state ' + st + '"><i class="led ' + st + '"></i><span class="st-t">' + esc(stateText(p)) + '</span></span>' + slot + '</div>' +
        '<div class="row-meta">' + esc(metaText(p)) + '</div>' +
      '</div>' +
      '<button class="more" data-act="menu" data-id="' + idq + '" aria-label="Actions for ' + esc(p.name) + '" aria-haspopup="dialog" aria-expanded="false">' + icon('more', true) + '</button>' +
    '</article>';
  }

  function emptyBoard() {
    var host = hostOf(state.hub.publicBase), slots = '';
    for (var i = 0; i < 3; i++) slots += '<div class="slot-row"><span class="slot-thumb"></span><span class="slot-lines"><i></i><i></i></span></div>';
    return '<div class="empty"><div class="slots" aria-hidden="true">' + slots + '</div>' +
      '<h3>No previews yet</h3>' +
      '<p>Agents publish dev servers, files and folders from the PC with the <b>preview</b> command. Each one gets a link like <b>' +
        esc(host) + '/&lt;id&gt;/</b> that keeps working after restarts.</p>' +
      '<ul class="cmds">' +
        '<li><code>preview add 5173</code><span>Share a dev server running on a port</span></li>' +
        '<li><code>preview add C:\\path\\to\\folder</code><span>Share a file or a folder</span></li>' +
      '</ul></div>';
  }

  function render() {
    if (!state) return;
    var all = state.previews;
    var list = all.filter(function (p) {
      if (!filterText) return true;
      return (p.name + ' ' + p.id + ' ' + (p.path || '') + ' ' + (p.target || '') + ' ' + (p.cwd || '')).toLowerCase().indexOf(filterText) >= 0;
    });
    var live = list.filter(function (p) { return p.status !== 'stopped'; });
    var stopped = list.filter(function (p) { return p.status === 'stopped'; });
    var c = state.counts, parts = [];
    if (c.live) parts.push(c.live + ' live');
    if (c.starting) parts.push(c.starting + ' starting');
    if (c.down) parts.push(c.down + ' not answering');
    if (c.stopped) parts.push(c.stopped + ' stopped');
    $('counts').textContent = parts.length ? parts.join(', ') : hostOf(state.hub.publicBase);
    $('leds').innerHTML = all.slice(0, 40).map(function (p) { return '<i class="led ' + p.status + '"></i>'; }).join('');
    $('liveN').textContent = live.length || '';
    $('stoppedN').textContent = stopped.length || '';
    $('liveH').hidden = !all.length;
    if (!all.length) $('live').innerHTML = emptyBoard();
    else if (!list.length) $('live').innerHTML = '<p class="empty-mini">No previews match “' + esc(filterText) + '”.</p>';
    else $('live').innerHTML = live.length ? live.map(row).join('') : '<p class="empty-mini">Nothing running. Start a stopped preview below.</p>';
    $('stopped').innerHTML = stopped.map(row).join('');
    $('stoppedSec').hidden = !stopped.length;
    $('filterWrap').hidden = all.length < 7;
    var t = state.hub.tunnel.status, el = $('tunnel');
    el.className = 'net ' + (t === 'connected' ? 'ok' : t === 'starting' || t === 'reconnecting' || t === 'checking' ? 'warn' : t === 'not-configured' ? '' : 'bad');
    el.querySelector('span').textContent = { connected: 'Online', 'not-configured': 'Local only', starting: 'Connecting', reconnecting: 'Reconnecting', checking: 'Checking', unreachable: 'Offline', down: 'Tunnel down' }[t] || t;
    el.title = t === 'connected' ? 'Public links work' : t === 'not-configured' ? 'No tunnel set up; links work on this PC only' : 'Public links: ' + t;
  }

  function byId(id) { return state && state.previews.find(function (p) { return p.id === id; }); }

  function act(name, id, el) {
    var p = byId(id); if (!p) return;
    if (name === 'copy') {
      (navigator.clipboard ? navigator.clipboard.writeText(p.url) : Promise.reject()).then(function () { toast('Link copied'); }, function () { prompt('Copy link', p.url); });
      return;
    }
    if (name === 'share') {
      if (navigator.share) navigator.share({ title: p.name, url: p.url }).catch(function () {});
      return;
    }
    if (name === 'menu') return openMenu(p, el);
    if (name === 'start') {
      if (el) { el.disabled = true; el.textContent = 'Starting…'; }
      return api('POST', 'previews/' + id + '/start', {}).then(function () { toast('Starting ' + p.name); load(true); }, function (e) { toast(e.message); load(true); });
    }
    if (name === 'stop') {
      toast('Stopping ' + p.name + '…');
      return api('POST', 'previews/' + id + '/stop', {}).then(function () { toast('Stopped ' + p.name); load(true); }, function (e) { toast(e.message); });
    }
    if (name === 'restart') {
      toast('Restarting ' + p.name + '…');
      return api('POST', 'previews/' + id + '/restart', {}).then(function () { toast('Restarting ' + p.name); load(); }, function (e) { toast(e.message); });
    }
    if (name === 'extend') return api('PATCH', 'previews/' + id, { ttl: '4h' }).then(function () { toast('Runs 4 more hours'); load(); }, function (e) { toast(e.message); });
    if (name === 'shot') { toast('Refreshing thumbnail…'); return api('POST', 'previews/' + id + '/shot', {}).then(function () { toast('Thumbnail updated'); load(); }, function (e) { toast(e.message); }); }
    if (name === 'delete') {
      if (!confirm('Delete "' + p.name + '"? Its snapshot and logs are removed.' + (p.status !== 'stopped' && p.managed ? ' The server will be stopped.' : ''))) return;
      toast('Deleting ' + p.name + '…');
      return api('DELETE', 'previews/' + id).then(function () { toast('Deleted'); load(true); }, function (e) { toast(e.message); });
    }
    if (name === 'edit') return openEdit(p);
    if (name === 'logs') return openLogs(p);
  }

  function facts(p) {
    var f = [], st = p.status;
    var when = st === 'stopped' ? ago(Date.now() - p.stoppedAt)
      : p.expiresIn == null ? 'no expiry'
      : short(p.expiresIn) + ' left' + (p.ttl ? ' of ' + short(p.ttl) : '');
    var word = st === 'stopped' ? (p.stopReason === 'expired' ? 'Expired' : 'Stopped') : { live: 'Live', starting: 'Starting', down: 'Not answering' }[st];
    f.push(['Status', '<span class="state ' + st + '"><i class="led ' + st + '"></i>' + word + '</span><span class="when">' + esc(when) + '</span>']);
    if (p.kind === 'proxy') {
      if (p.cmd) f.push(['Runs', '<span class="mono">' + esc(p.cmd) + '</span>']);
      if (p.cwd) f.push(['In', '<span class="mono" title="' + esc(p.cwd) + '">' + esc(shortPath(p.cwd)) + '</span>']);
      f.push(['Server', esc(p.target ? p.target.replace(/^https?:\/\//, '') : 'port not found yet')]);
    } else if (p.path) {
      f.push(['Path', '<span class="mono" title="' + esc(p.path) + '">' + esc(shortPath(p.path)) + '</span>']);
    }
    f.push(['Added', (p.by ? 'by ' + esc(p.by) + ', ' : '') + ago(Date.now() - p.createdAt)]);
    if (p.hits) f.push(['Visits', p.hits + (p.lastHitAt ? ', last ' + ago(Date.now() - p.lastHitAt) : '')]);
    if (p.private) f.push(['Access', 'Private: viewers log in']);
    if (st === 'down' && !p.canStart) f.push(['Note', 'No start command saved. Start it on the PC, or add one in Edit.']);
    return '<dl class="facts">' + f.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>';
  }

  function openMenu(p, anchor) {
    var m = $('menu'), stopped = p.status === 'stopped', sheet = narrow.matches;
    if (menuTrigger && menuTrigger !== anchor) menuTrigger.setAttribute('aria-expanded', 'false');
    menuTrigger = anchor || null;
    var quick = [];
    if ((stopped || p.status === 'down') && p.canStart) quick.push('<button class="q q-go" data-mact="start">' + icon('play', true) + 'Start</button>');
    quick.push('<a class="q" href="' + esc(p.url) + '" target="_blank" rel="noopener">' + icon('open') + (stopped || p.status === 'down' ? 'Snapshot' : 'Open') + '</a>');
    quick.push('<button class="q" data-mact="copy">' + icon('copy') + 'Copy link</button>');
    if (navigator.share && quick.length < 3) quick.push('<button class="q" data-mact="share">' + icon('share') + 'Share</button>');
    var items = [];
    if (!stopped) items.push(['extend', 'Run 4 more hours', 'clock']);
    if (!stopped && p.status === 'live') items.push(['shot', 'Refresh thumbnail', 'image']);
    if (!stopped && p.kind === 'proxy' && p.cmd) items.push(['restart', 'Restart server', 'restart']);
    if (p.kind === 'proxy') items.push(['logs', 'Logs', 'logs']);
    items.push(['edit', 'Edit', 'edit']);
    items.push(['-']);
    if (!stopped) items.push(['stop', p.managed ? 'Stop server' : 'Stop sharing', 'stop']);
    items.push(['delete', 'Delete', 'trash', 'danger']);
    m.innerHTML = (sheet ? '<div class="grab" aria-hidden="true"></div>' : '') +
      '<div class="sh-head">' + thumb(p) + '<div class="sh-txt"><p class="sh-name">' + esc(p.name) + '</p><p class="sh-url">' + esc(String(p.url).replace(/^https?:\/\//, '')) + '</p></div></div>' +
      facts(p) +
      '<div class="quick">' + quick.join('') + '</div>' +
      '<div class="items">' + items.map(function (i) {
        return i[0] === '-' ? '<hr>' : '<button data-mact="' + i[0] + '"' + (i[3] ? ' class="' + i[3] + '"' : '') + '>' + icon(i[2]) + i[1] + '</button>';
      }).join('') + '</div>';
    m.className = 'menu' + (sheet ? ' is-sheet' : '');
    m.setAttribute('aria-label', 'Actions for ' + p.name);
    m.style.left = ''; m.style.top = '';
    m.hidden = false;
    $('scrim').hidden = !sheet;
    document.documentElement.classList.toggle('lock', sheet);
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    if (!sheet && anchor) {
      var r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
      var left = Math.min(window.innerWidth - mw - 8, Math.max(8, r.right - mw));
      var top = r.bottom + 6 + mh > window.innerHeight ? r.top - mh - 6 : r.bottom + 6;
      m.style.left = left + 'px'; m.style.top = Math.max(8, top) + 'px';
    }
    m.scrollTop = 0;
    m.onclick = function (e) {
      if (e.target.closest('a')) { closeMenu(true); return; }
      var b = e.target.closest('button[data-mact]'); if (!b) return;
      closeMenu(true); act(b.dataset.mact, p.id);
    };
    var first = m.querySelector('.q, .items button');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu(keepFocus) {
    var m = $('menu');
    if (m.hidden) return;
    m.hidden = true; $('scrim').hidden = true;
    document.documentElement.classList.remove('lock');
    if (menuTrigger) {
      menuTrigger.setAttribute('aria-expanded', 'false');
      if (keepFocus !== false && document.body.contains(menuTrigger)) menuTrigger.focus({ preventScroll: true });
    }
    menuTrigger = null;
  }

  function openEdit(p) {
    editing = p;
    var f = $('editForm');
    f.name.value = p.name;
    var tl = ttlLabel(p.ttl), keep = f.ttl.querySelector('option[value="keep"]');
    if (keep) keep.remove();
    if (tl) f.ttl.value = tl;
    else {
      keep = document.createElement('option'); keep.value = 'keep'; keep.textContent = 'Current: ' + dur(p.ttl);
      f.ttl.insertBefore(keep, f.ttl.firstChild); f.ttl.value = 'keep';
    }
    f.private.checked = !!p.private;
    f.target.value = p.kind === 'static' ? (p.path || '') : (p.target || '');
    $('targetLbl').querySelector('.lbl').textContent = p.kind === 'static' ? 'File or folder' : 'Server URL';
    $('editSub').textContent = String(p.url).replace(/^https?:\/\//, '');
    $('procFields').hidden = p.kind === 'static';
    f.cmd.value = p.cmd || ''; f.cwd.value = p.cwd || ''; f.passcode.value = '';
    $('pcLbl').hidden = true; $('editErr').hidden = true;
    f.dataset.ttl0 = f.ttl.value;
    $('editDlg').showModal();
  }
  function procChanged() {
    var f = $('editForm');
    return editing && (f.cmd.value !== (editing.cmd || '') || f.cwd.value !== (editing.cwd || ''));
  }

  $('editForm').addEventListener('input', function () { $('pcLbl').hidden = !procChanged(); });
  $('editForm').addEventListener('submit', function (e) {
    var f = $('editForm');
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    var p = editing, body = {};
    if (f.name.value !== p.name) body.name = f.name.value;
    if (f.ttl.value !== f.dataset.ttl0) body.ttl = f.ttl.value;
    if (f.private.checked !== !!p.private) body.private = f.private.checked;
    var t0 = p.kind === 'static' ? (p.path || '') : (p.target || '');
    if (f.target.value !== t0) body.target = f.target.value;
    if (procChanged()) { body.cmd = f.cmd.value; body.cwd = f.cwd.value; body.passcode = f.passcode.value; }
    if (!Object.keys(body).length) { $('editDlg').close(); return; }
    $('editSave').disabled = true;
    api('PATCH', 'previews/' + p.id, body).then(function () {
      $('editDlg').close(); toast('Saved'); load(true);
    }, function (err) { $('editErr').textContent = err.message; $('editErr').hidden = false; })
      .then(function () { $('editSave').disabled = false; });
  });

  function openLogs(p) {
    logId = p.id; $('logTitle').textContent = p.name + ' logs'; $('logBody').textContent = 'Loading…';
    $('logDlg').showModal(); refreshLogs();
  }
  function refreshLogs() {
    api('GET', 'previews/' + logId + '/logs?lines=300').then(function (j) {
      var b = $('logBody'); b.textContent = j.log || '(no output yet)'; b.scrollTop = b.scrollHeight;
    }, function (e) { $('logBody').textContent = e.message; });
  }
  $('logRefresh').onclick = refreshLogs;
  $('logClose').onclick = function () { $('logDlg').close(); };
  $('logDlg').addEventListener('click', function (e) { if (e.target === this) this.close(); });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (b) { e.preventDefault(); act(b.dataset.act, b.dataset.id, b); return; }
    if (!e.target.closest('#menu')) closeMenu(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', function () { if (!$('menu').classList.contains('is-sheet')) closeMenu(false); }, { passive: true });
  narrow.addEventListener('change', function () { closeMenu(false); });
  $('filter').addEventListener('input', function (e) { filterText = e.target.value.trim().toLowerCase(); render(); });

  function schedule() { clearTimeout(timer); timer = setTimeout(function () { if (!document.hidden && !document.querySelector('dialog[open]') && $('menu').hidden) load().then(schedule); else schedule(); }, 4000); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  load().then(schedule);
})();
