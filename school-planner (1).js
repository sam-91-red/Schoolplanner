/* School Planner card for Home Assistant (week view with hours)
 * Shows a kid's to-do lists as sticky notes. They drag a note onto a day and hour (or tap a note, then tap a slot)
 * to plan their week, and they can type in their own things to do. Uses Local To-do lists. */

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PALETTE = ['#7c5cff', '#12b886', '#f76707', '#e64980'];
const shortDate = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const hourLabel = (h) => (h % 12 || 12) + (h < 12 ? ' am' : ' pm');

class SchoolPlannerCard extends HTMLElement {
  setConfig(config) {
    let lists = config.lists;
    if (!lists || !lists.length) {
      if (!config.entity) throw new Error('Set "lists" to your to-do lists. See the setup steps.');
      lists = [config.entity];
    }
    this._lists = lists.map((l, i) => {
      const o = typeof l === 'string' ? { entity: l } : l;
      return {
        entity: o.entity,
        label: o.label || (lists.length > 1 ? (i === 0 ? 'School' : 'Mine') : 'My list'),
        color: o.color || (i === 0 && config.color) || PALETTE[i % PALETTE.length],
      };
    });
    this._config = { title: 'My Week', days: 5, start_hour: 8, end_hour: 15, allow_delete: true, ...config };
    const at = this._lists.findIndex((l) => l.entity === config.add_to);
    this._addIndex = at >= 0 ? at : this._lists.length - 1;
    this._items = this._items || [];
    this._offset = this._offset || 0;
    this._selected = null;
    this._error = '';
    this._draft = this._draft || { text: '', day: '', hour: '', list: '' };
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this._wire();
    }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._lists) return;
    const key = this._lists.map((l) => (hass.states[l.entity] ? hass.states[l.entity].state : 'missing')).join('|');
    if (key !== this._key) {
      this._key = key;
      this._load();
    }
  }

  getCardSize() {
    return 12;
  }

  // Works out which day, and which hour if there is one, an item is planned for.
  _when(it) {
    if (!it.due) return null;
    const s = String(it.due);
    if (s.length <= 10) return { key: s, hour: null, label: '' };
    const d = new Date(s.replace(' ', 'T'));
    if (isNaN(d)) return null;
    return { key: ymd(d), hour: d.getHours(), label: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) };
  }

  _weekDays() {
    const n = Number(this._config.days) === 7 ? 7 : 5;
    const t = new Date();
    t.setHours(12, 0, 0, 0);
    let dow = t.getDay();
    if (n === 5 && (dow === 0 || dow === 6)) t.setDate(t.getDate() + (dow === 0 ? 1 : 2));
    dow = t.getDay();
    t.setDate(t.getDate() + (dow === 0 ? -6 : 1 - dow) + this._offset * 7);
    const days = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(t);
      d.setDate(t.getDate() + i);
      days.push(d);
    }
    return days;
  }

  async _load() {
    const items = [];
    const errs = [];
    for (let li = 0; li < this._lists.length; li++) {
      try {
        const res = await this._hass.callWS({ type: 'todo/item/list', entity_id: this._lists[li].entity });
        for (const it of res.items || []) items.push({ ...it, _li: li });
      } catch (e) {
        errs.push(this._lists[li].entity + ': ' + ((e && e.message) || 'could not be read'));
      }
    }
    this._items = items;
    if (errs.length) this._error = errs.join(' | ');
    this._render();
  }

  _find(ref) {
    const p = ref.indexOf('|');
    const li = ref.slice(0, p);
    const uid = ref.slice(p + 1);
    return this._items.find((i) => String(i._li) === li && i.uid === uid);
  }

  async _svc(li, service, data) {
    let ok = true;
    try {
      await this._hass.callService('todo', service, { entity_id: this._lists[li].entity, ...data });
      this._error = '';
    } catch (e) {
      ok = false;
      this._error = (e && e.message) || 'That did not work.';
    }
    this._selected = null;
    await this._load();
    return ok;
  }

  _timing(key, hour) {
    if (hour === '' || hour == null) return { due_date: key };
    return { due_datetime: `${key} ${String(hour).padStart(2, '0')}:00:00` };
  }

  _place(ref, key, hour) {
    const it = this._find(ref);
    if (it) return this._svc(it._li, 'update_item', { item: it.uid, ...this._timing(key, hour) });
  }

  async _unplace(ref) {
    const it = this._find(ref);
    if (!it) return;
    const base = { entity_id: this._lists[it._li].entity, item: it.uid };
    try {
      await this._hass.callService('todo', 'update_item', { ...base, due_date: null });
      this._error = '';
    } catch (e) {
      try {
        await this._hass.callService('todo', 'update_item', { ...base, due_datetime: null });
        this._error = '';
      } catch (e2) {
        this._error = 'Could not move it back: ' + ((e2 && e2.message) || 'unknown problem');
      }
    }
    this._selected = null;
    await this._load();
  }

  _toggle(ref) {
    const it = this._find(ref);
    if (it) return this._svc(it._li, 'update_item', { item: it.uid, status: it.status === 'completed' ? 'needs_action' : 'completed' });
  }

  _remove(ref) {
    const it = this._find(ref);
    if (!it) return;
    if (window.confirm && !window.confirm('Delete "' + it.summary + '"?')) return;
    return this._svc(it._li, 'remove_item', { item: [it.uid] });
  }

  _target() {
    const n = this._draft.list === '' || this._draft.list == null ? this._addIndex : Number(this._draft.list);
    return n >= 0 && n < this._lists.length ? n : this._addIndex;
  }

  async _add() {
    const text = (this._draft.text || '').trim();
    if (!text) return;
    const data = { item: text };
    if (this._draft.day) Object.assign(data, this._timing(this._draft.day, this._draft.hour));
    const saved = this._draft.text;
    this._draft.text = '';
    const ok = await this._svc(this._target(), 'add_item', data);
    if (!ok) {
      this._draft.text = saved;
      this._render();
    }
  }

  _wire() {
    const r = this.shadowRoot;
    r.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const { act, ref, key, hour } = t.dataset;
      if (act === 'select') {
        this._selected = this._selected === ref ? null : ref;
        this._render();
      } else if (act === 'done') this._toggle(ref);
      else if (act === 'back') this._unplace(ref);
      else if (act === 'del') this._remove(ref);
      else if (act === 'add') this._add();
      else if (act === 'slot') {
        if (this._selected) this._place(this._selected, key, hour);
      } else if (act === 'prev' || act === 'next' || act === 'today') {
        this._offset = act === 'today' ? 0 : this._offset + (act === 'next' ? 1 : -1);
        this._selected = null;
        this._render();
      }
    });
    r.addEventListener('input', (e) => {
      if (e.target.matches && e.target.matches('.addtxt')) this._draft.text = e.target.value;
    });
    r.addEventListener('change', (e) => {
      if (!e.target.matches) return;
      if (e.target.matches('.when')) this._draft.day = e.target.value;
      if (e.target.matches('.hr')) this._draft.hour = e.target.value;
      if (e.target.matches('.which')) {
        this._draft.list = e.target.value;
        this._render();
      }
    });
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches && e.target.matches('.addtxt')) {
        e.preventDefault();
        this._add();
      }
    });
    r.addEventListener('dragstart', (e) => {
      const c = e.target.closest('[draggable][data-ref]');
      if (!c) return;
      e.dataTransfer.setData('text/plain', c.dataset.ref);
      e.dataTransfer.effectAllowed = 'move';
    });
    r.addEventListener('dragover', (e) => {
      if (e.target.closest('[data-key], [data-pool]')) e.preventDefault();
    });
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      const ref = e.dataTransfer.getData('text/plain');
      if (!ref) return;
      const slot = e.target.closest('[data-key]');
      if (slot) this._place(ref, slot.dataset.key, slot.dataset.hour);
      else if (e.target.closest('[data-pool]')) this._unplace(ref);
    });
  }

  _render() {
    const c = this._config;
    if (!c || !this.shadowRoot) return;
    const ae = this.shadowRoot.activeElement;
    const refocus = !!(ae && ae.matches && ae.matches('.addtxt'));

    const startH = Math.max(0, Math.min(23, Number(c.start_hour) || 0));
    const endH = Math.max(startH, Math.min(23, Number(c.end_hour) || 15));
    const hours = [];
    for (let h = startH; h <= endH; h++) hours.push(h);

    const days = this._weekDays();
    const keys = days.map((d) => ymd(d));
    const todayKey = ymd(new Date());
    const byDay = {};
    keys.forEach((k) => {
      byDay[k] = { any: [], hrs: {} };
      hours.forEach((h) => (byDay[k].hrs[h] = []));
    });
    const pool = [];
    for (const it of this._items) {
      const w = this._when(it);
      if (!w) {
        if (it.status !== 'completed') pool.push(it);
      } else if (byDay[w.key]) {
        if (w.hour !== null && byDay[w.key].hrs[w.hour]) byDay[w.key].hrs[w.hour].push(it);
        else byDay[w.key].any.push(w.hour !== null ? { ...it, _timeLabel: w.label } : it);
      } else if (w.key < todayKey && w.key < keys[0] && it.status !== 'completed') pool.push({ ...it, _earlier: true });
    }
    const order = (a, b) => (a.status === 'completed') - (b.status === 'completed') || String(a.summary).localeCompare(String(b.summary));
    if (!keys.includes(this._draft.day)) this._draft.day = '';

    const chip = (it, sched) => {
      const ref = it._li + '|' + it.uid;
      const L = this._lists[it._li];
      const done = it.status === 'completed';
      const w = this._when(it);
      const late = sched && !done && w && w.key < todayKey;
      const own = c.allow_delete !== false && it._li === this._addIndex;
      return `
        <div class="note ${this._selected === ref ? 'picked' : ''} ${done ? 'done' : ''} ${late ? 'late' : ''}"
             style="--c:${esc(L.color)}" draggable="true" data-act="select" data-ref="${esc(ref)}">
          <div class="line">
            <button class="chk" data-act="done" data-ref="${esc(ref)}" aria-label="Mark done">${done ? '✓' : ''}</button>
            <span class="txt"><b>${esc(it.summary)}</b>${it._timeLabel ? `<small>${esc(it._timeLabel)}</small>` : ''}${it.description ? `<small>${esc(it.description)}</small>` : ''}${late ? '<small class="lt">not finished yet</small>' : ''}${it._earlier ? '<small class="lt">from an earlier day</small>' : ''}</span>
          </div>
          <div class="acts">${sched ? `<button data-act="back" data-ref="${esc(ref)}">Back to list</button>` : ''}${own ? `<button data-act="del" data-ref="${esc(ref)}" aria-label="Delete">🗑</button>` : ''}</div>
        </div>`;
    };

    const slot = (k, h, list) => `
      <div class="slot" data-act="slot" data-key="${k}" data-hour="${h === null ? '' : h}">
        <div class="tm">${h === null ? 'Any' : hourLabel(h)}</div>
        <div class="sl">${list.sort(order).map((i) => chip(i, true)).join('')}</div>
      </div>`;

    const col = (d) => {
      const k = ymd(d);
      const b = byDay[k];
      return `
        <div class="day ${k === todayKey ? 'today' : ''} ${k < todayKey ? 'past' : ''}">
          <div class="dh" data-act="slot" data-key="${k}" data-hour=""><b>${DAY[d.getDay()]}</b><span>${d.getDate()}</span></div>
          ${slot(k, null, b.any)}
          ${hours.map((h) => slot(k, h, b.hrs[h])).join('')}
        </div>`;
    };

    const legend =
      this._lists.length > 1
        ? `<div class="legend">${this._lists.map((l) => `<span><i style="background:${esc(l.color)}"></i>${esc(l.label)}</span>`).join('')}</div>`
        : '';
    const dayOptions =
      '<option value="">Plan it later</option>' +
      days.map((d, i) => `<option value="${keys[i]}" ${keys[i] === this._draft.day ? 'selected' : ''}>${DAY[d.getDay()]} ${d.getDate()}</option>`).join('');
    const hourOptions =
      `<option value="">Any time</option>` +
      hours.map((h) => `<option value="${h}" ${String(h) === String(this._draft.hour) ? 'selected' : ''}>${hourLabel(h)}</option>`).join('');
    const range = `${shortDate(days[0])} to ${shortDate(days[days.length - 1])}`;
    const n = days.length;
    const accent = esc(this._lists[0].color);
    const addColor = esc(this._lists[this._target()].color);
    const whichOptions = this._lists
      .map((l, i) => `<option value="${i}" ${i === this._target() ? 'selected' : ''}>${esc(l.label)}</option>`)
      .join('');

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; font-family: ui-rounded, 'Nunito', 'Trebuchet MS', sans-serif; }
        .head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
        .head h2 { margin: 0; font-size: 1.6rem; color: ${accent}; }
        .nav button { font: inherit; border: 0; border-radius: 999px; padding: 8px 14px; margin-left: 6px; cursor: pointer;
                      background: var(--secondary-background-color); color: var(--primary-text-color); }
        .range { color: var(--secondary-text-color); margin: 2px 0 10px; }
        .err { background: #ffe3e0; color: #8a1f11; border-radius: 10px; padding: 8px 12px; margin-bottom: 10px; }
        .add { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
        .addtxt { flex: 1 1 200px; font: inherit; font-size: 1rem; padding: 12px 14px; border-radius: 14px; min-width: 0;
                  border: 2px solid ${addColor}; background: var(--card-background-color); color: var(--primary-text-color); }
        .when, .hr, .which { font: inherit; padding: 10px; border-radius: 14px; border: 2px solid var(--divider-color);
                     background: var(--card-background-color); color: var(--primary-text-color); }
        .go { font: inherit; font-weight: 700; border: 0; border-radius: 14px; padding: 10px 20px; cursor: pointer; color: #fff; background: ${addColor}; }
        .legend { display: flex; gap: 14px; margin-bottom: 8px; color: var(--secondary-text-color); font-size: .9rem; }
        .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
        .pool { border-radius: 16px; padding: 10px 12px 4px; margin-bottom: 12px; background: var(--secondary-background-color); }
        .pool h3 { margin: 0 0 8px; font-size: 1.05rem; }
        .poolnotes { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
        .days { display: grid; grid-template-columns: repeat(${n}, minmax(0, 1fr)); gap: 8px; }
        @media (max-width: 700px) { .days { grid-template-columns: 1fr; } }
        .day { border-radius: 14px; padding: 6px; border: 2px dashed var(--divider-color); }
        .day.today { border: 2px solid ${accent}; }
        .day.past { opacity: .85; }
        .dh { display: flex; justify-content: space-between; padding: 2px 6px 6px; }
        .day.today .dh { color: ${accent}; }
        .slot { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 4px; min-height: 38px; padding: 3px 0;
                border-top: 1px dashed var(--divider-color); }
        .tm { font-size: .75rem; color: var(--secondary-text-color); padding-top: 6px; }
        .note { margin-bottom: 6px; padding: 6px 8px; border-radius: 6px 12px 6px 12px; cursor: grab; color: var(--primary-text-color);
                background: var(--secondary-background-color);
                background: color-mix(in srgb, var(--c) 18%, var(--card-background-color, #fff));
                border-left: 6px solid var(--c); box-shadow: 0 2px 0 rgba(0,0,0,.12); }
        .note.picked { outline: 3px solid var(--c); }
        .note.done { opacity: .55; }
        .note.done b { text-decoration: line-through; }
        .note.late { outline: 2px solid #e03131; }
        .line { display: flex; gap: 8px; align-items: flex-start; }
        .txt { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        small { display: block; opacity: .75; margin-top: 2px; }
        small.lt { color: #e03131; opacity: 1; }
        .chk { width: 26px; height: 26px; flex: none; border-radius: 50%; border: 2px solid var(--c); background: var(--card-background-color);
               color: var(--c); font-weight: 900; cursor: pointer; padding: 0; }
        .acts { display: flex; justify-content: flex-end; gap: 6px; }
        .acts button { font: inherit; font-size: .8rem; border: 0; background: transparent; color: var(--secondary-text-color); cursor: pointer; padding: 2px 4px; }
        .empty, .hint { color: var(--secondary-text-color); font-size: .9rem; margin: 4px 0 8px; }
      </style>
      <ha-card>
        <div class="head">
          <h2>${esc(c.title)}</h2>
          <div class="nav"><button data-act="prev" aria-label="Last week">◀</button><button data-act="today">This week</button><button data-act="next" aria-label="Next week">▶</button></div>
        </div>
        <div class="range">${esc(range)}</div>
        ${this._error ? `<div class="err">${esc(this._error)}</div>` : ''}
        <div class="add">
          ${this._lists.length > 1 ? `<select class="which" aria-label="Which list">${whichOptions}</select>` : ''}
          <input class="addtxt" type="text" maxlength="120" enterkeyhint="done" placeholder="Add something to my plan..." value="${esc(this._draft.text)}">
          <select class="when" aria-label="Which day">${dayOptions}</select>
          <select class="hr" aria-label="Which hour">${hourOptions}</select>
          <button class="go" data-act="add">Add</button>
        </div>
        ${legend}
        <div class="pool" data-pool="1">
          <h3>To plan</h3>
          ${pool.length ? `<div class="poolnotes">${pool.sort(order).map((i) => chip(i, false)).join('')}</div>` : '<p class="empty">Everything is planned!</p>'}
          <p class="hint">Drag a note onto a day and hour. Or tap a note, then tap a spot. The top spot, "Any", means any time that day.</p>
        </div>
        <div class="days">${days.map(col).join('')}</div>
      </ha-card>`;

    if (refocus) {
      const i = this.shadowRoot.querySelector('.addtxt');
      if (i) {
        i.focus();
        try {
          i.setSelectionRange(i.value.length, i.value.length);
        } catch (e) {
          /* some inputs do not allow this */
        }
      }
    }
  }
}

customElements.define('school-planner-card', SchoolPlannerCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'school-planner-card',
  name: 'School Planner',
  description: 'A week view where kids drag school work onto days and hours and add their own to-dos.',
});
