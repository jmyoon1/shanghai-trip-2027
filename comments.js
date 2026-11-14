// Comments for the slide site. Storage: a Google Sheet behind an Apps Script web app (window.COMMENTS_URL).
// A comment is pinned to a point on a slide (x, y in 1920x1080 slide units) or to the whole slide (x = -1).
// The commenter's name is kept in localStorage so it is asked only once per browser.
(function () {
  const URL_ = window.COMMENTS_URL || '';
  const D = window.deck;
  const NAME_KEY = 'trip-comment-name', TOK_KEY = 'trip-comment-tokens';
  let all = [], draft = null, selRoot = null, replyTo = null, busy = false;

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: name is kept for this visit only */ } },
  };
  let memName = ls.get(NAME_KEY, '');
  const tokens = (() => { try { return JSON.parse(ls.get(TOK_KEY, '{}')) || {}; } catch (e) { return {}; } })();
  function saveName(n) { memName = n; ls.set(NAME_KEY, n); }

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---------- DOM ----------
  const drawer = el('aside'); drawer.id = 'cdrawer';
  drawer.innerHTML = '<header><h3>댓글</h3><span class="sub"></span><button class="cx" aria-label="닫기">&#215;</button></header><div class="cbody"></div>';
  document.body.appendChild(drawer);
  const body = drawer.querySelector('.cbody'), sub = drawer.querySelector('.sub');
  drawer.querySelector('.cx').onclick = () => toggle(false);
  const toast = el('div', 'ctoast'); document.body.appendChild(toast);
  function say(t) { toast.textContent = t; toast.classList.add('show'); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove('show'), 2200); }

  D.S.forEach(s => {
    const p = el('div', 'cpins'); s.appendChild(p);
    const c = el('div', 'cpick'); s.appendChild(c);
    c.addEventListener('click', e => pickAt(s, e));
  });
  const btn = document.getElementById('cbtn'), cnum = document.getElementById('cnum');
  btn.onclick = () => toggle(!document.body.classList.contains('cop'));

  function mobile() { return innerWidth <= 760; }
  function toggle(on) {
    document.body.classList.toggle('cop', on);
    if (!on) { document.body.classList.remove('picking'); draft = null; replyTo = null; }
    window.sideW = on && !mobile() ? 380 : 0;
    window.bottomH = on && mobile() ? Math.round(innerHeight * 0.58) : 0;
    D.fit(); render();
    if (on) load();
  }
  addEventListener('resize', () => { if (document.body.classList.contains('cop')) toggle(true); });

  // ---------- picking a spot ----------
  function anchorText(s, e) {
    const pick = s.querySelector('.cpick'), pins = s.querySelector('.cpins');
    pick.style.display = 'none'; pins.style.display = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    pick.style.display = ''; pins.style.display = '';
    if (!under || !s.contains(under)) return '';
    if (under.closest('.livewrap')) return '지도';
    const box = under.closest('.card, .sline, .trow, .check, .step, h1, h2, h3, .lead, .eyebrow, .note, p') || under;
    return (box.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  function pickAt(s, e) {
    const r = s.getBoundingClientRect(), k = D.k();
    const x = Math.round((e.clientX - r.left) / k), y = Math.round((e.clientY - r.top) / k);
    draft = { slide: s.id, x, y, anchor: anchorText(s, e) || '이 위치' };
    document.body.classList.remove('picking');
    selRoot = null; replyTo = null;
    render();
    const ta = body.querySelector('.ccompose textarea'); if (ta) ta.focus();
  }

  // ---------- data ----------
  async function load() {
    if (!URL_) return;
    try {
      const r = await fetch(URL_ + (URL_.includes('?') ? '&' : '?') + 'action=list&t=' + Date.now());
      const j = await r.json();
      if (j.ok) {
        all = j.comments;
        // do not wipe what someone is typing: refresh only pins and badge then
        const typing = body.contains(document.activeElement) || Array.from(body.querySelectorAll('textarea, input')).some(x => x.value);
        render(typing);
      }
    } catch (e) { say('댓글을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.'); }
  }
  async function post(obj) {
    const r = await fetch(URL_, { method: 'POST', body: JSON.stringify(obj) });
    return r.json();
  }
  async function add(c) {
    if (busy) return; busy = true;
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    try {
      const j = await post(Object.assign({ action: 'add', token }, c));
      if (!j.ok) throw new Error(j.error);
      tokens[j.comment.id] = token; ls.set(TOK_KEY, JSON.stringify(tokens));
      all.push(j.comment);
      return j.comment;
    } catch (e) { say('저장하지 못했어요. 인터넷 연결을 확인해 주세요.'); return null; }
    finally { busy = false; }
  }
  async function del(id) {
    try {
      const j = await post({ action: 'delete', id, token: tokens[id] });
      if (!j.ok) throw new Error(j.error);
      all = all.filter(c => c.id !== id && c.parent !== id);
      delete tokens[id]; ls.set(TOK_KEY, JSON.stringify(tokens));
      render();
    } catch (e) { say('지우지 못했어요.'); }
  }

  // ---------- render ----------
  const fmt = t => { const d = new Date(t); return isNaN(d) ? '' : (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  function roots(slideId) { return all.filter(c => c.slide === slideId && !c.parent).sort((a, b) => a.time < b.time ? -1 : 1); }
  function replies(id) { return all.filter(c => c.parent === id).sort((a, b) => a.time < b.time ? -1 : 1); }

  function render(pinsOnly) {
    const s = D.cur();
    // count badge: comments on this slide
    const n = all.filter(c => c.slide === s.id).length;
    cnum.textContent = n ? String(n) : '';
    // pins
    D.S.forEach(sl => {
      const box = sl.querySelector('.cpins'); box.innerHTML = '';
      roots(sl.id).forEach((c, i) => {
        if (c.x < 0) return;
        const p = el('button', 'cpin' + (selRoot === c.id ? ' sel' : ''), String(i + 1));
        p.style.left = c.x + 'px'; p.style.top = c.y + 'px'; p.title = c.name + ': ' + c.text.slice(0, 40);
        p.onclick = () => { selRoot = c.id; if (!document.body.classList.contains('cop')) toggle(true); else render(); scrollSel(); };
        box.appendChild(p);
      });
      if (draft && draft.slide === sl.id && draft.x >= 0) {
        const p = el('div', 'cpin draft', '+'); p.style.left = draft.x + 'px'; p.style.top = draft.y + 'px'; box.appendChild(p);
      }
    });
    if (pinsOnly || !document.body.classList.contains('cop')) return;
    const title = s.querySelector('h1, h2');
    sub.textContent = title ? title.innerText.replace(/\s+/g, ' ').slice(0, 26) : '';
    // keep what was typed in the composer across re-renders (e.g. after picking a spot)
    const oldN = body.querySelector('.ccompose input'), oldT = body.querySelector('.ccompose textarea');
    const keepN = oldN ? oldN.value : '', keepT = oldT ? oldT.value : '';
    body.innerHTML = '';
    if (!URL_) { body.appendChild(el('p', 'cnote', '댓글 저장소를 아직 연결하지 않았어요. 연결되면 여기에서 댓글을 달 수 있어요.')); return; }

    // name
    const nm = el('div', 'cname');
    if (memName) {
      nm.append('이름 ', el('b', null, memName), ' ');
      const ch = el('button', 'clink', '바꾸기'); ch.onclick = () => { saveName(''); render(); }; nm.appendChild(ch);
    } else {
      nm.textContent = '처음 한 번만 이름을 적으면 이 브라우저에서 계속 기억해요.';
    }
    body.appendChild(nm);

    // composer
    const cp = el('div', 'ccompose');
    let nameIn = null;
    if (!memName) { nameIn = el('input'); nameIn.placeholder = '이름'; nameIn.maxLength = 40; nameIn.value = keepN; cp.appendChild(nameIn); }
    const where = el('div', 'cwhere');
    if (draft && draft.slide === s.id) {
      where.append('위치: ', el('b', null, draft.anchor), ' ');
      const clr = el('button', 'clink', '위치 빼기'); clr.onclick = () => { draft = null; render(); }; where.appendChild(clr);
    } else {
      where.append('위치: 이 장 전체 ');
      const pk = el('button', 'clink', '슬라이드에서 위치 고르기');
      pk.onclick = () => { document.body.classList.add('picking'); say('댓글 달 곳을 슬라이드에서 눌러 주세요'); };
      where.appendChild(pk);
    }
    cp.appendChild(where);
    const ta = el('textarea'); ta.placeholder = '댓글'; ta.maxLength = 2000; ta.value = keepT; cp.appendChild(ta);
    const row = el('div', 'crow');
    if (document.body.classList.contains('picking')) {
      const cn = el('button', 'cbtn2 ghost', '위치 고르기 취소'); cn.onclick = () => { document.body.classList.remove('picking'); render(); }; row.appendChild(cn);
    }
    const go = el('button', 'cbtn2', '등록');
    go.onclick = async () => {
      const name = memName || (nameIn && nameIn.value.trim());
      const text = ta.value.trim();
      if (!name) { say('이름을 적어 주세요'); nameIn && nameIn.focus(); return; }
      if (!text) { say('댓글을 적어 주세요'); ta.focus(); return; }
      if (!memName) saveName(name);
      go.disabled = true;
      const d = draft && draft.slide === s.id ? draft : { slide: s.id, x: -1, y: -1, anchor: '이 장 전체' };
      const c = await add({ name, text, slide: d.slide, x: d.x, y: d.y, anchor: d.anchor, parent: '' });
      go.disabled = false;
      if (c) { ta.value = ''; draft = null; selRoot = c.id; render(); scrollSel(); }
    };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go.click(); });
    row.appendChild(go); cp.appendChild(row);
    body.appendChild(cp);

    // threads
    const rs = roots(s.id);
    if (!rs.length) body.appendChild(el('p', 'cempty', '이 장에는 아직 댓글이 없어요.'));
    rs.forEach(c => {
      const t = el('div', 'cthread' + (selRoot === c.id ? ' sel' : '')); t.dataset.id = c.id;
      const anc = el('div', 'anc');
      if (c.x >= 0) { anc.appendChild(el('span', 'cno', String(rs.filter(r => r.x >= 0).indexOf(c) + 1))); }
      anc.appendChild(el('span', null, c.anchor || '이 장 전체'));
      t.appendChild(anc);
      [c].concat(replies(c.id)).forEach(m => t.appendChild(msg(m, m !== c)));
      if (replyTo === c.id) {
        const rb = el('div', 'creply');
        const rta = el('textarea'); rta.placeholder = '답글'; rta.maxLength = 2000; rb.appendChild(rta);
        const rr = el('div', 'crow');
        const cn = el('button', 'cbtn2 ghost', '취소'); cn.onclick = () => { replyTo = null; render(); };
        const ok = el('button', 'cbtn2', '답글 등록');
        ok.onclick = async () => {
          if (!memName) { say('위 칸에 이름을 먼저 적어 주세요'); return; }
          const text = rta.value.trim(); if (!text) return;
          ok.disabled = true;
          const r = await add({ name: memName, text, slide: c.slide, x: c.x, y: c.y, anchor: c.anchor, parent: c.id });
          ok.disabled = false;
          if (r) { replyTo = null; render(); }
        };
        rr.append(cn, ok); rb.appendChild(rr); t.appendChild(rb);
        setTimeout(() => rta.focus(), 0);
      } else {
        const rr = el('div', 'crow');
        const rp = el('button', 'clink', '답글'); rp.onclick = () => { replyTo = c.id; selRoot = c.id; render(); };
        rr.appendChild(rp); t.appendChild(rr);
      }
      t.addEventListener('click', e => { if (e.target === t || e.target.closest('.anc')) { selRoot = c.id; render(); } });
      body.appendChild(t);
    });
  }
  function msg(m, isReply) {
    const d = el('div', 'cmsg' + (isReply ? ' reply' : ''));
    const who = el('div', 'who'); who.append(el('b', null, m.name), ' · ' + fmt(m.time) + ' ');
    if (tokens[m.id]) {
      const x = el('button', 'clink', '지우기');
      x.onclick = () => { if (x.dataset.sure) del(m.id); else { x.dataset.sure = '1'; x.textContent = '정말 지우기'; } };
      who.appendChild(x);
    }
    d.append(who, el('div', 'ctxt', m.text));
    return d;
  }
  function scrollSel() { const t = body.querySelector('.cthread.sel'); if (t) t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  document.addEventListener('slidechange', () => { replyTo = null; if (draft && draft.slide !== D.cur().id) draft = null; render(); });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 60000);
})();
