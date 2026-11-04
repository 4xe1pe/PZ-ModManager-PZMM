/* Row selection for the Mods table: plain click, Ctrl+click (toggle), Shift+click (range from the
 * anchor), Ctrl+A (all). Pure functions so they can be unit-tested with node (test/selection.test.js). */
(function () {
  const newState = () => ({ set: new Set(), anchor: null });

  /** drop ids that are no longer listed */
  function prune(order, s) {
    const ok = new Set(order);
    return { set: new Set([...s.set].filter((id) => ok.has(id))), anchor: ok.has(s.anchor) ? s.anchor : null };
  }

  function clickRow(order, s, id, o = {}) {
    if (!order.includes(id)) return s;
    if (o.shift && s.anchor && order.includes(s.anchor)) {
      const a = order.indexOf(s.anchor), b = order.indexOf(id);
      const set = o.ctrl ? new Set(s.set) : new Set();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(order[i]);
      return { set, anchor: s.anchor }; // the anchor stays where it was
    }
    if (o.ctrl) {
      const set = new Set(s.set);
      if (set.has(id)) set.delete(id); else set.add(id);
      return { set, anchor: id };
    }
    return { set: new Set([id]), anchor: id };
  }

  function selectAll(order, s) {
    return { set: new Set(order), anchor: order.includes(s.anchor) ? s.anchor : (order[0] ?? null) };
  }

  const api = { newState, prune, clickRow, selectAll };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.Sel = api;
})();