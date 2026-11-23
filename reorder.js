// リアルタイムに詰め替わる並べ替え (ポインター操作) の共通部品。ピンのグリッドと Today 欄で使う。
//
// つかんだ項目は浮いてポインターに付いて動き、ほかの項目はその場で滑らかに詰め替わる。離した位置で確定、Esc で取り消し。
// ブラウザ標準のドラッグ&ドロップは、ドラッグ中に一覧を描き直すと中断され、項目の隙間に落とすと何も起きないため使わない。
// 入れ替え先は offsetLeft/Top (配置上の位置) で判定する。getBoundingClientRect (アニメーション中の見た目の位置) で
// 判定すると、滑って動いている途中の項目を基準にしてしまい、境目で行ったり来たりする。
//
// 使い方:
//   const r = setupLiveReorder({
//     container,                 // 項目の親 (position: relative にしておく)
//     itemSelector,              // 並べ替える項目 (container の直接の子)
//     canStart(e, item),         // ドラッグを始めてよいか
//     onCommit(orderedItems, movedItem),  // 離したとき (並びが変わったときだけ)
//     onEnd(),                   // 終了時 (確定・取り消しとも)。保留していた描き直しなどをここで
//     companion(item),           // 任意。項目の直後に置いてあり、項目と一緒に動かす要素 (フォルダの子コンテナなど)。無ければ null
//     dropTarget(x, y, item),    // 任意。並べ替えではなく「別の場所へ入れる / 出す」先。{ el, cls, ... } か null。
//                                //   el に cls を付けて示し、その間は並べ替え (詰め替え) を止める
//     onDrop(target, item),      // 任意。dropTarget / combineTarget の先で離したとき (onCommit の代わりに呼ぶ)
//     detach(e, item),           // 任意。項目の一部 (Today 欄の分割行の 1 ペインなど) をつかんだとき、それだけを引き出す関数を返す (無ければ null)。
//                                //   ドラッグが始まったら呼ばれ、引き出した分の新しい項目を container に入れて返す。以後はそれを動かし、
//                                //   離せば並びが同じでも onCommit (または onDrop) を呼ぶ。取り消し時の後始末 (新しい項目を消す) は onEnd の描き直しで
//     combineTarget(item, over, x, y), // 任意。ほかの項目 over に重ねて「まとめる」(Today 欄の分割表示) 先。組めるなら { el, cls, ... }、組めないなら null。
//                                //   組める相手は、高さの中央の半分に入ったときだけ先になる。入れ替えは相手の奥側 1/4 まで進んだときに行う
//     combineGrid: true,         // 任意。項目が格子 (お気に入りのグリッド) に並ぶときの結合の判定にする。結合の帯は相手の中央の正方形 (縦横とも中心から 1/4)、
//                                //   入れ替えはそこを抜けて進行方向の奥側 1/4 に出たとき。行の一覧 (Today 欄、ピン留めタブ) は指定しない (従来の式のまま)
//   });
//   r.isDragging()  // 描き直しを保留する判定に使う

const COMBINE_BAND = 0.25; // まとめられる相手の中央の帯 (中心から上下に高さの 1/4)

// 相手の項目と入れ替える位置まで来たか。rel は相手の中心からの縦のずれ (高さに対する割合)、down は下へ動かしているか。
// 境目でのばたつきを防ぐため、ふつうは相手の中心寄り (7 割の範囲) に入ったときだけ入れ替える。
// まとめられる相手は中央の帯を「まとめる」に空けておくので、手前側では入れ替えず、奥側 1/4 まで進んだときに入れ替える
function swapReached(rel, down, combinable) {
  if (!combinable) return Math.abs(rel) <= 0.35;
  return down ? rel > COMBINE_BAND : rel < -COMBINE_BAND;
}

// 格子の版。relX / relY は相手の中心からのずれ (幅 / 高さに対する割合)。手前側 (進行方向と逆) では入れ替えない。
// down は動かしている項目が相手より前 (リストの前方) にあるか。同じ行の隣 (relY ≈ 0) でも、横に 1/4 以上奥へ進めば入れ替わる
function swapReachedGrid(relX, relY, down, combinable) {
  if (!combinable) return Math.abs(relY) <= 0.35;
  return down ? (relX > COMBINE_BAND || relY > COMBINE_BAND) : (relX < -COMBINE_BAND || relY < -COMBINE_BAND);
}

function setupLiveReorder({ container, itemSelector, canStart, onCommit, onEnd, companion, dropTarget, onDrop, detach, combineTarget, combineGrid = false }) {
  let drag = null; // { el, pointerId, started, startX, startY, offsetX, offsetY, ghost, initialOrder, target, detach, detached }

  const items = () => [...container.children].filter((el) => el.matches(itemSelector));
  // 項目とその相方 (フォルダの子コンテナなど) をひとまとまりで動かす
  const unit = (el) => { const m = companion?.(el); return m ? [el, m] : [el]; };
  const layoutBox = (el, cRect) => ({ x: cRect.left + el.offsetLeft, y: cRect.top + el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag) return;
    const el = e.target.closest(itemSelector);
    if (!el || el.parentElement !== container || !canStart(e, el)) return;
    const r = el.getBoundingClientRect();
    drag = {
      el, pointerId: e.pointerId, started: false,
      startX: e.clientX, startY: e.clientY, offsetX: e.clientX - r.left, offsetY: e.clientY - r.top,
      detach: detach?.(e, el) || null, // ここでは引き出さない (動かさずに離せばただのクリック)
    };
    // ここではポインターを捕まえない。pointerdown で捕捉すると pointerup の対象が親になり、click イベントが
    // 項目ではなく親に飛んで、項目のクリック処理 (タブの切り替えなど) が動かなくなる。捕捉はドラッグ開始時 (start) に行う
  });

  // 動きと離す操作は document で受ける。項目が小さい (お気に入りのタイルなど) と、最初の pointermove が親の外で起きて
  // ドラッグが始まらないことがあるため。捕捉 (start) の後も document まで届く
  document.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return; // 小さな揺れはクリック扱い
      start();
    }
    drag.ghost.style.transform = `translate(${e.clientX - drag.offsetX}px, ${e.clientY - drag.offsetY}px) scale(1.04)`;
    const out = dropTarget ? dropTarget(e.clientX, e.clientY, drag.el) : null;
    if (out) setTarget(out);
    else movePlaceholder(e.clientX, e.clientY);
  });

  document.addEventListener("pointerup", (e) => finish(e.pointerId, true));
  document.addEventListener("pointercancel", (e) => finish(e.pointerId, false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drag?.started) { e.preventDefault(); e.stopImmediatePropagation(); finish(drag.pointerId, false); }
  }, true);

  function start() {
    drag.started = true;
    // 親は動かさないので、ここでポインターを捕まえておけばパネル外で離しても pointerup が届く
    try { container.setPointerCapture(drag.pointerId); } catch { /* ポインターが既に無い */ }
    drag.initialOrder = items();
    if (drag.detach) {
      // 引き出した分を新しい項目として動かす。元の並び (initialOrder) に無い項目なので、離せば必ず確定として扱う
      drag.el = drag.detach();
      drag.detached = true;
    }
    const r = drag.el.getBoundingClientRect();
    const ghost = drag.el.cloneNode(true);
    ghost.classList.add("reorder-ghost");
    ghost.removeAttribute("id");
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    for (const el of unit(drag.el)) el.classList.add("placeholder");
    container.classList.add("reordering");
  }

  // 「入れる / 出す」先の表示を付け替える。先がある間は詰め替えをしない
  function setTarget(t) {
    const cur = drag.target;
    if (cur?.el === t?.el && cur?.cls === t?.cls) return;
    cur?.el.classList.remove(cur.cls);
    t?.el.classList.add(t.cls);
    drag.target = t || null;
  }

  // いちばん近い項目を相手に、まとめる先 (combineTarget) を示すか、並びを詰め替える
  function movePlaceholder(x, y) {
    const cRect = container.getBoundingClientRect();
    const list = items();
    let best = null, bestDist = Infinity;
    for (const el of list) {
      const b = layoutBox(el, cRect);
      const dist = (x - (b.x + b.w / 2)) ** 2 + (y - (b.y + b.h / 2)) ** 2;
      if (dist < bestDist) { bestDist = dist; best = el; }
    }
    if (!best || best === drag.el) return setTarget(null);
    const bb = layoutBox(best, cRect);
    const rel = (y - (bb.y + bb.h / 2)) / bb.h; // 相手の中心からの縦のずれ (高さに対する割合)
    const merge = combineTarget?.(drag.el, best, x, y) || null;
    const relX = (x - (bb.x + bb.w / 2)) / bb.w;
    if (merge && Math.abs(rel) <= COMBINE_BAND && (!combineGrid || Math.abs(relX) <= COMBINE_BAND)) return setTarget(merge);
    setTarget(null);
    if (Math.abs(relX) > (combineGrid && merge ? 0.5 : 0.35)) return; // 格子で組める相手の奥側は、上限を緩める
    const down = list.indexOf(drag.el) < list.indexOf(best);
    if (!(combineGrid ? swapReachedGrid(relX, rel, down, !!merge) : swapReached(rel, down, !!merge))) return;
    const all = list.flatMap(unit);
    const before = new Map(all.map((el) => [el, el.getBoundingClientRect()]));
    const moving = unit(drag.el);
    // 相手がフォルダなら、その子コンテナの後ろ (= フォルダのまとまりの外) に入れる
    if (list.indexOf(drag.el) < list.indexOf(best)) unit(best).at(-1).after(...moving); else best.before(...moving);
    for (const el of all) {
      if (moving.includes(el) || el.hidden) continue;
      const a = before.get(el), nb = layoutBox(el, cRect);
      const dx = a.left - nb.x, dy = a.top - nb.y;
      el.getAnimations().forEach((an) => an.cancel());
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 160, easing: "ease-out" });
      }
    }
  }

  async function finish(pointerId, commit) {
    const d = drag;
    if (!d || pointerId !== d.pointerId) return;
    drag = null;
    try { container.releasePointerCapture(d.pointerId); } catch { /* 既に解放済み */ }
    if (!d.started) return; // 動かさずに離した = ただのクリック
    const target = d.target || null;
    target?.el.classList.remove(target.cls);
    d.ghost.remove();
    for (const el of unit(d.el)) el.classList.remove("placeholder");
    container.classList.remove("reordering");
    const order = items();
    const changed = !!d.detached || order.some((el, i) => el !== d.initialOrder[i]);
    if (!commit && changed) {
      // 取り消し: 元の並びに戻す
      const kept = d.initialOrder.flatMap(unit);
      container.append(...kept);
      const rest = [...container.children].filter((el) => !kept.includes(el));
      for (const el of rest) container.appendChild(el); // 追加用タイルなど、並べ替え対象外は後ろへ
    }
    try {
      if (commit && target) await onDrop(target, d.el); // 入れる / 出す (並びは onEnd の描き直しで整う)
      else if (commit && changed) await onCommit(order, d.el);
    } finally {
      onEnd?.();
    }
  }

  return { isDragging: () => !!drag?.started };
}
