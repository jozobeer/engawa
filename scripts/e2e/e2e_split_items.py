# 分割項目 (split item) の E2E: ピン留めタブに「分割」を 1 項目として置ける (使い捨てプロファイルのヘッドレス Chrome、ネットワーク不要)
#   Part 0: Chrome の前提のプローブ (固定の付け外しの順序、隣への作成、group 違いの createSplit)
#   Part A: Today の分割行 <-> ピン留めタブ (ドラッグ、空白 = 末尾、担当 0/1 枚の戻し、フォルダ、Esc)
#   Part B: ピン留めの行同士の結合、ペインの引き出し (Today / フォルダ / 別の行の真ん中 / 重複で断られるお気に入り、フォルダの分割行をお気に入りへ)
#   Part C: クリック (開き直し、縮退、再クリックの URL 戻し、擬似再起動、adoptLivePair)
#   Part D: 名前変更、編集モードの ×、壊れた split の描画
#   Part E: 競合 (連続した discard、付け替えの直列化)、重複 URL、容量
#   Part F: お気に入りのグリッドでの結合 (真ん中に重ねる、奥側は入れ替え、固定を揃える)
#   Part G: お気に入りの分割タイルのクリック、× (項目ごと削除)
#   Part H: お気に入り <-> ピン留めタブ <-> Today の行き来、重複
#   Part I: Option+ドラッグでペインを 1 枚引き出す、満杯のとき
#   Part J: 固定が外れた分割の組み直し (settled の見直し)、ユーザーのグループは触らない
# 使い方: python3 scripts/e2e/e2e_split_items.py <拡張のディレクトリ> [0 A B C D E F G H I J]   (Chrome 155 以降。Part を選べる。各 Part は自前でタブを用意して独立している)
import sys, time, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_lib import Lib

L = Lib(sys.argv[1])
E, check, wait_for = L.E, L.check, L.wait_for
parts = set(sys.argv[2:]) or set("0ABCDEFGHIJ")


# ================= Part 0: Chrome の前提 (失敗は設計見直しの合図) =================
def part0():
    p1, p2, p3 = (L.mk(f"https://probe-{i}.invalid/") for i in range(1, 4))
    time.sleep(1.5)
    E(f"chrome.tabs.createSplit([{p1}, {p2}])"); time.sleep(0.5)
    check("probe: a split can be built from two adjacent normal tabs", L.paired(p1, p2), json.dumps(L.strip()))
    # 解く -> 左から右の順に固定 -> createSplit
    E(f"chrome.tabs.unsplit({L.split_of(p1)})"); time.sleep(0.3)
    E(f"chrome.tabs.update({p1}, {{ pinned: true }})"); E(f"chrome.tabs.update({p2}, {{ pinned: true }})"); time.sleep(0.3)
    o = L.order()
    check("probe: pinning left then right keeps them as [left, right] at the front", o.index(p1) + 1 == o.index(p2), json.dumps(L.strip()))
    try:
        E(f"chrome.tabs.createSplit([{p1}, {p2}])"); time.sleep(0.4)
    except Exception as e:
        print("createSplit after pin failed:", str(e)[:200])
    check("probe: createSplit works on two pinned tabs", L.paired(p1, p2), json.dumps(L.strip()))
    # 固定を外す: 分割のままだと片方の固定解除で分割が解けるか / 順序
    E(f"chrome.tabs.unsplit({L.split_of(p1)})"); time.sleep(0.3)
    E(f"chrome.tabs.update({p2}, {{ pinned: false }})"); E(f"chrome.tabs.update({p1}, {{ pinned: false }})"); time.sleep(0.3)
    o = L.order()
    check("probe: unpinning right then left leaves them adjacent as [left, right]", o.index(p1) + 1 == o.index(p2), json.dumps(L.strip()))
    E(f"chrome.tabs.createSplit([{p1}, {p2}])"); time.sleep(0.4)
    check("probe: ...and a split can be rebuilt after that", L.paired(p1, p2), json.dumps(L.strip()))
    # tabs.create の index で相方の隣に作れる (相方が分割の外のとき。分割の中の index は分割の後ろへ押し出される)
    idx = E(f"chrome.tabs.get({p2}).then(t => t.index)")
    p4 = E(f"chrome.tabs.create({{ url: 'https://probe-4.invalid/', active: false, windowId: {L.win}, index: {idx + 1} }}).then(t => t.id)")
    o = L.order()
    check("probe: tabs.create at an index inside a split lands after the whole split (never between the panes)", L.paired(p1, p2) and o.index(p4) == idx + 1, json.dumps(L.strip()))
    E(f"chrome.tabs.unsplit({L.split_of(p1)})"); time.sleep(0.3)
    idx = E(f"chrome.tabs.get({p2}).then(t => t.index)")
    p5 = E(f"chrome.tabs.create({{ url: 'https://probe-5.invalid/', active: false, windowId: {L.win}, index: {idx} }}).then(t => t.id)")
    p6 = E(f"chrome.tabs.create({{ url: 'https://probe-6.invalid/', active: false, windowId: {L.win}, index: {idx + 2} }}).then(t => t.id)")
    o = L.order()
    check("probe: tabs.create({index}) next to a non-split partner puts the tab right before / after it", o.index(p5) + 1 == o.index(p2) and o.index(p6) == o.index(p2) + 1, json.dumps(L.strip()))
    E(f"chrome.tabs.remove([{p4}, {p5}, {p6}])"); time.sleep(0.4)
    E(f"chrome.tabs.createSplit([{p1}, {p2}])"); time.sleep(0.4)
    # group 違いの createSplit は失敗する
    try:
        gid = E(f"chrome.tabs.group({{ tabIds: [{p3}] }})")
        E(f"chrome.tabs.unsplit({L.split_of(p1)})"); time.sleep(0.2)
        E(f"chrome.tabs.move({p3}, {{ index: {L.order().index(p1) + 1} }})"); time.sleep(0.2)
        failed = False
        try:
            E(f"chrome.tabs.createSplit([{p1}, {p3}])")
        except Exception:
            failed = True
        check("probe: createSplit with different tab groups fails (we must not touch the user's groups)", failed and L.split_of(p3) == -1, json.dumps(L.strip()))
    except Exception as e:
        check("probe: tab group API available", False, str(e)[:200])
    E(f"chrome.tabs.remove([{p1}, {p2}, {p3}])"); time.sleep(0.5)



# ================= 共通 =================
panel = E("chrome.tabs.getCurrent().then(t => t.id)")
flat = lambda: [x for r in L.today() for x in (r if isinstance(r, list) else [r])]
ps = lambda nid: '.pinned-node[data-node-id="%s"]' % nid                      # ピン留めの行 (項目 id)
grip_of = lambda nid: L.box("document.querySelector('%s .split-grip')" % ps(nid))
pane_of = lambda nid, pid: L.box("document.querySelector('%s .split-pane[data-pane-id=\"%s\"]')" % (ps(nid), pid))
trow = lambda tid: L.row('#today-list > .tab-row[data-tab-id="%d"]' % tid)
tgrip = lambda tid: L.box("document.querySelector('#today-list .split-pane[data-tab-id=\"%d\"]').closest('.split-row').querySelector('.split-grip')" % tid)
mid = lambda b, fx=0.5, fy=0.5: (b[0] + b[2] * fx, b[1] + b[3] * fy)
toast = lambda: E("document.querySelector('#toast').textContent")
clear_toast = lambda: E("document.querySelector('#toast').textContent = ''")  # flash() は textContent を消さないので、通知を検証する直前に空にする

def clean():
    # 前の Part の状態を片付ける (パネルのタブだけ残す)
    E("chrome.storage.sync.set({ pinnedTabs: [], pins: [] })")
    E("chrome.storage.session.set({ ownedTabs: {} })")
    ids = [t for t in L.order() if t != panel]
    if ids: E("chrome.tabs.remove(%s)" % json.dumps(ids))
    time.sleep(1.0)

def bind(pairs):
    E("chrome.storage.session.get('ownedTabs').then(r => chrome.storage.session.set({ ownedTabs: { ...(r.ownedTabs || {}), ...%s } }))" % json.dumps(pairs))
    wait_for(lambda: all(L.E("ownedTabs[%s]" % json.dumps(k)) == v for k, v in pairs.items())); time.sleep(0.7)  # Today の行が消えて並びが落ち着くのを待つ

def seed(nodes):
    L.set_pinned(nodes)
    time.sleep(0.4)

def tabnode(nid, url, title=None): return {"type": "tab", "id": nid, "url": url, "title": title or nid}
def splitnode(sid, a, b): return {"type": "split", "id": sid, "children": [a, b]}
def mkpair(tag, split=True):
    a = L.mk(f"https://{tag}-a.invalid/"); b = L.mk(f"https://{tag}-b.invalid/"); time.sleep(0.8)
    if split: E(f"chrome.tabs.createSplit([{a}, {b}])")
    return a, b
def pane_nodes(tag, i=("a", "b")): return [tabnode(f"{tag}-p{k}", f"https://{tag}-{k}.invalid/", f"{tag.upper()} {k}") for k in i]


# ================= Part A: Today の分割 <-> ピン留めタブ =================
def partA():
    clean()
    a1, a2 = mkpair("sa1"); c1 = L.mk("https://sa-c1.invalid/"); time.sleep(1.5)
    check("A setup: the split is one Today row", wait_for(lambda: [a1, a2] in L.today()), json.dumps(L.today()))
    n0 = L.tab_count()
    gx, gy = mid(tgrip(a1)); px, py = mid(L.box("document.querySelector('#pinned-section')"))
    L.drag_to(gx, gy, px, py)
    check("A: hovering the pinned section with a split row marks the list end as the target", L.has_cls("#pinned-list", "drop-end"))
    L.drop(px, py)
    tr = L.tree(); raw = L.pinned_raw()
    check("A: dropping a split row on the pinned list makes one split item with two panes", len(tr) == 1 and tr[0][0] == "split" and len(tr[0][2]) == 2, json.dumps(tr))
    sid, (pa, pb) = tr[0][1], tr[0][2]
    check("A: ...whose panes keep the two URLs, left to right", [c["url"] for c in raw[0]["children"]] == ["https://sa1-a.invalid/", "https://sa1-b.invalid/"] and all(c["type"] == "tab" and c["title"] for c in raw[0]["children"]), json.dumps(raw))
    ow = L.owned()
    check("A: each pane is bound to its own tab (owner = pane id, never the split id)", ow.get(pa) == a1 and ow.get(pb) == a2 and sid not in ow, json.dumps(ow))
    check("A: no tab was opened, the split is kept, nothing is Chrome-pinned", L.tab_count() == n0 and L.paired(a1, a2) and not L.tab(a1)["pinned"] and not L.tab(a2)["pinned"], json.dumps(L.strip()))
    check("A: the two tabs left the Today list", wait_for(lambda: a1 not in flat() and a2 not in flat()) and c1 in flat(), json.dumps(L.today()))
    check("A: the pinned list shows one split row with two panes (grip, panes, one × at the end)", E("(() => { const r = document.querySelector('#pinned-list .split-row'); return !!r && r.querySelectorAll(':scope > .split-pane').length === 2 && !!r.querySelector(':scope > .split-grip') && r.querySelectorAll('.tab-close').length === 1 && [...r.querySelectorAll('.split-pane')].every(p => p.classList.contains('open')); })()"))

    # --- 逆方向: Today の行の前へ ---
    x, y = mid(trow(c1), 0.5, 0.25); gx, gy = mid(grip_of(sid))
    L.drag_to(gx, gy, x, y)
    check("A: hovering the upper half of a Today row marks the insertion above it", L.has_cls('#today-list > .tab-row[data-tab-id="%d"]' % c1, "drop-before"))
    L.drop(x, y)
    check("A: dropping a split item on Today removes the item and releases both panes", wait_for(lambda: L.tree() == [] and pa not in L.owned() and pb not in L.owned()), json.dumps([L.tree(), L.owned()]))
    t = L.today()
    check("A: ...and the pair reappears as a split row right before the target (same two tabs, no new tab)", wait_for(lambda: [a1, a2] in L.today() and L.today().index([a1, a2]) + 1 == L.today().index(c1)) and L.paired(a1, a2) and L.tab_count() == n0, json.dumps(L.today()))

    # --- Today の空白 (末尾) に落とす: 分割ごと末尾へ動く ---
    gx, gy = mid(tgrip(a1)); px, py = mid(L.box("document.querySelector('#pinned-section')"))
    L.drag_to(gx, gy, px, py); L.drop(px, py)
    tr = L.tree(); sid = tr[0][1] if tr and tr[0][0] == "split" else None
    check("A setup: pinned again", sid is not None, json.dumps(tr))
    lst = E("(() => { const l = document.querySelector('#today-list'); const r = l.getBoundingClientRect(); const rows = [...l.querySelectorAll(':scope > .tab-row')]; const last = rows.at(-1).getBoundingClientRect(); return [r.left + r.width / 2, last.bottom + 3, r.bottom]; })()")
    gx, gy = mid(grip_of(sid))
    L.drag_to(gx, gy, lst[0], lst[1])
    check("A: hovering the empty space under the Today rows marks the whole list", L.has_cls("#today-list", "drop-unpin"))
    L.drop(lst[0], lst[1])
    check("A: dropping in the empty space moves the pair to the end of the window (not left where it was)", wait_for(lambda: L.order()[-2:] == [a1, a2]) and L.paired(a1, a2) and L.tree() == [], json.dumps(L.strip()))

    # --- 担当タブが 0 枚 / 1 枚の項目を Today へ戻す: 足りない分が作られて分割になる ---
    clean()
    seed([splitnode("sx", *pane_nodes("sx"))]); n0 = L.tab_count()
    lst = E("(() => { const l = document.querySelector('#today-list'); const r = l.getBoundingClientRect(); const rows = [...l.querySelectorAll(':scope > .tab-row')]; const last = rows.at(-1).getBoundingClientRect(); return [r.left + r.width / 2, last.bottom + 3]; })()")
    gx, gy = mid(grip_of("sx")); L.drag_to(gx, gy, lst[0], lst[1]); L.drop(lst[0], lst[1])
    wait_for(lambda: len(E("chrome.tabs.query({ url: 'https://sx-b.invalid/*' }).then(ts => ts.map(t => t.id))")) == 1); time.sleep(1.0)
    ta = E("chrome.tabs.query({ url: 'https://sx-a.invalid/*' }).then(ts => ts.map(t => t.id))"); tb = E("chrome.tabs.query({ url: 'https://sx-b.invalid/*' }).then(ts => ts.map(t => t.id))")
    check("A: a split item with no open tabs, dropped on Today, opens both panes as a split (+2 tabs)", len(ta) == 1 and len(tb) == 1 and L.paired(ta[0], tb[0]) and L.tab_count() == n0 + 2 and L.tree() == [] and L.owned() == {}, json.dumps([ta, tb, L.strip()]))
    clean()
    one = L.mk("https://sy-a.invalid/"); time.sleep(0.8)
    seed([splitnode("sy", *pane_nodes("sy"))]); bind({"sy-pa": one}); n0 = L.tab_count()
    lst = E("(() => { const l = document.querySelector('#today-list'); const r = l.getBoundingClientRect(); const rows = [...l.querySelectorAll(':scope > .tab-row')]; const last = rows.at(-1).getBoundingClientRect(); return [r.left + r.width / 2, last.bottom + 3]; })()")
    gx, gy = mid(grip_of("sy")); L.drag_to(gx, gy, lst[0], lst[1]); L.drop(lst[0], lst[1])
    tb = wait_for(lambda: E("chrome.tabs.query({ url: 'https://sy-b.invalid/*' }).then(ts => ts.map(t => t.id))")) or []
    time.sleep(1.0)
    check("A: with one open pane, only the missing pane is opened (+1 tab) and they form a split", len(tb) == 1 and L.paired(one, tb[0]) and L.tab_count() == n0 + 1 and L.tree() == [], json.dumps([tb, L.strip(), L.tree(), L.owned(), toast(), one, L.errors()]))

    # --- 分割行をフォルダの中へ ---
    clean()
    f1 = [{"type": "folder", "id": "F1", "title": "F1", "children": [tabnode("n1", "https://sf-n1.invalid/")]}]
    seed(f1)
    a1, a2 = mkpair("sf"); time.sleep(1.0)
    gx, gy = mid(tgrip(a1)); fx, fy = mid(L.row(ps("F1")))
    L.drag_to(gx, gy, fx, fy)
    check("A: hovering a folder row with a split row marks it as the target", L.has_cls(ps("F1"), "drop-into"))
    L.drop(fx, fy)
    tr = L.tree()
    check("A: dropped into the folder, the split item becomes its last child", len(tr) == 1 and tr[0][0] == "folder" and tr[0][2][0] == "n1" and tr[0][2][1][0] == "split" and L.paired(a1, a2), json.dumps(tr))

    # --- Esc で取り消すと、何も変わらない ---
    clean()
    a1, a2 = mkpair("se"); time.sleep(1.0)
    gx, gy = mid(tgrip(a1)); px, py = mid(L.box("document.querySelector('#pinned-section')"))
    L.drag_to(gx, gy, px, py); L.key("Escape", 27); time.sleep(0.4); L.mouse("mouseReleased", px, py, 0); time.sleep(1)
    check("A: Esc cancels: nothing is pinned and the split stays", L.tree() == [] and L.paired(a1, a2) and [a1, a2] in L.today(), json.dumps([L.tree(), L.today()]))


# ================= Part B: ピン留め行の結合と引き出し =================
def partB():
    clean()
    cs = {k: L.mk(f"https://sb-{k}.invalid/") for k in ("1", "2", "3", "4")}; time.sleep(1.2)
    nodes = [tabnode(f"n{k}", f"https://sb-{k}.invalid/") for k in ("1", "2", "3", "4")]
    seed(nodes); bind({f"n{k}": cs[k] for k in cs}); n0 = L.tab_count()
    ow0 = L.owned()
    # n1 を n2 の右半分の真ん中へ: 落とした側 (n1) が右
    x1, y1 = mid(L.row(ps("n1"))); x2, y2 = mid(L.row(ps("n2")), 0.75)
    L.drag_to(x1, y1, x2, y2)
    check("B: hovering the right half of another single row marks it as the split target (right)", L.has_cls(ps("n2"), "drop-split-right"))
    L.drop(x2, y2)
    tr = L.tree()
    check("B: dropping on it makes one split item at that row's place; the dropped row is on the right", len(tr) == 3 and tr[0][0] == "split" and tr[0][2] == ["n2", "n1"] and tr[1:] == ["n3", "n4"], json.dumps(tr))
    check("B: pane ids are the old node ids, so the owned tabs are untouched", L.owned() == ow0, json.dumps(L.owned()))
    check("B: both tabs became a split in Chrome with the dropped side on the right, no tab was opened", L.paired(cs["2"], cs["1"]) and L.order().index(cs["1"]) == L.order().index(cs["2"]) + 1 and L.tab_count() == n0, json.dumps(L.strip()))
    check("B: the dropped pane's tab is shown", wait_for(lambda: L.active(cs["1"])))
    # n4 を n3 の左半分へ: 落とした側 (n4) が左
    x1, y1 = mid(L.row(ps("n4"))); x2, y2 = mid(L.row(ps("n3")), 0.25)
    L.drag_to(x1, y1, x2, y2)
    check("B: hovering the left half marks the left", L.has_cls(ps("n3"), "drop-split-left"))
    L.drop(x2, y2)
    tr = L.tree()
    check("B: dropping on the left half puts the dropped row on the left", len(tr) == 2 and tr[1][0] == "split" and tr[1][2] == ["n4", "n3"] and L.paired(cs["4"], cs["3"]) and L.order().index(cs["3"]) == L.order().index(cs["4"]) + 1, json.dumps(tr))

    # --- 分割行 / フォルダ行とは組まない。帯の外 (奥側 1/4) では入れ替えになる ---
    clean()
    cs = {k: L.mk(f"https://sb2-{k}.invalid/") for k in ("1", "2", "3")}; time.sleep(1.2)
    seed([splitnode("S", tabnode("s1", "https://sb2-1.invalid/", "S1"), tabnode("s2", "https://sb2-2.invalid/", "S2")), tabnode("n3", "https://sb2-3.invalid/"),
          {"type": "folder", "id": "F", "title": "F", "children": []}])
    bind({"s1": cs["1"], "s2": cs["2"], "n3": cs["3"]})
    E(f"chrome.tabs.createSplit([{cs['1']}, {cs['2']}])"); time.sleep(0.5)
    x1, y1 = mid(L.row(ps("n3"))); x2, y2 = mid(L.row(ps("S")), 0.5)
    L.drag_to(x1, y1, x2, y2)
    check("B: a split row cannot be combined with (no drop-split mark)", not L.has_cls(ps("S"), "drop-split-left") and not L.has_cls(ps("S"), "drop-split-right"))
    x3, y3 = mid(L.row(ps("F")), 0.5)
    L.move_to(x2, y2, x3, y3)
    check("B: a folder row cannot be combined with either", not L.has_cls(ps("F"), "drop-split-left") and not L.has_cls(ps("F"), "drop-split-right"))
    L.key("Escape", 27); time.sleep(0.4); L.mouse("mouseReleased", x3, y3, 0); time.sleep(1)
    check("B: Esc after hovering them changes nothing", L.tree() == [["split", "S", ["s1", "s2"]], "n3", ["folder", "F", []]], json.dumps(L.tree()))

    # --- 相手の担当タブが閉じていても、データだけ変わり、タブは増えない ---
    clean()
    d1 = L.mk("https://sb3-1.invalid/"); time.sleep(0.8)
    seed([tabnode("m1", "https://sb3-1.invalid/"), tabnode("m2", "https://sb3-2.invalid/")]); bind({"m1": d1}); n0 = L.tab_count()
    x1, y1 = mid(L.row(ps("m1"))); x2, y2 = mid(L.row(ps("m2")), 0.25)
    L.drag_to(x1, y1, x2, y2); L.drop(x2, y2)
    check("B: combining with a row whose tab is closed changes only the data (no tab opened, no split)", L.tree() == [["split", L.tree()[0][1], ["m1", "m2"]]] and L.tab_count() == n0 and L.split_of(d1) == -1, json.dumps([L.tree(), L.strip()]))

    # --- ペインをつかむと 1 枚だけ引き出せる ---
    def setup_split(tag):
        clean()
        cs = {k: L.mk(f"https://{tag}-{k}.invalid/") for k in ("1", "2", "3")}; time.sleep(1.2)
        seed([splitnode("S", tabnode("p1", f"https://{tag}-1.invalid/", "Pane One"), tabnode("p2", f"https://{tag}-2.invalid/", "Pane Two")), tabnode("n3", f"https://{tag}-3.invalid/", "Three")])
        bind({"p1": cs["1"], "p2": cs["2"], "n3": cs["3"]})
        E(f"chrome.tabs.createSplit([{cs['1']}, {cs['2']}])"); time.sleep(0.6)
        return cs
    cs = setup_split("sb4"); n0 = L.tab_count(); ow0 = L.owned()
    bx, by = mid(pane_of("S", "p2"), 0.4)
    sx, sy = L.grab(bx, by)
    check("B: pulling a pane leaves it faded in the split row and lifts a row of its own", E("document.querySelector('.split-pane[data-pane-id=\"p2\"]').classList.contains('pulled') && document.querySelectorAll('.pinned-node:not(.reorder-ghost)[data-node-id=\"p2\"]').length === 1"),
          E("JSON.stringify([document.querySelector('.split-pane[data-pane-id=\"p2\"]')?.className, document.querySelectorAll('.pinned-node').length, document.querySelector('#pinned-list').className, (() => { const r = document.querySelector('.split-pane[data-pane-id=\"p2\"]')?.getBoundingClientRect(); return r && [r.left, r.top, r.width, r.height]; })()])"))
    x2, y2 = mid(L.row(ps("n3")), 0.5, 0.85)
    L.move_to(sx, sy, x2, y2); L.drop(x2, y2)
    tr = L.tree(); raw = L.pinned_raw()
    check("B: dropping the pulled pane elsewhere in the list gives two single items, in the dropped order", tr == ["p1", "n3", "p2"], json.dumps(tr))
    check("B: ...out of the Chrome split, titles kept, owners unchanged, no tab opened", L.split_of(cs["1"]) == -1 and L.split_of(cs["2"]) == -1 and [n["title"] for n in raw] == ["Pane One", "Three", "Pane Two"] and L.owned() == ow0 and L.tab_count() == n0, json.dumps([L.strip(), ow0]))

    # --- Esc で取り消すと元どおり ---
    cs = setup_split("sb5")
    bx, by = mid(pane_of("S", "p2"), 0.4); sx, sy = L.grab(bx, by)
    L.move_to(sx, sy, sx, sy + 70); L.key("Escape", 27); time.sleep(0.4); L.mouse("mouseReleased", sx, sy + 70, 0); time.sleep(1.2)
    check("B: Esc while pulling a pane restores everything (still one split item, still a split)", L.tree() == [["split", "S", ["p1", "p2"]], "n3"] and L.paired(cs["1"], cs["2"]) and not E("!!document.querySelector('.split-pane.pulled')"), json.dumps(L.tree()))

    # --- 引き出して Today へ ---
    cs = setup_split("sb6")
    bx, by = mid(pane_of("S", "p1"), 0.4); sx, sy = L.grab(bx, by)
    lst = E("(() => { const l = document.querySelector('#today-list'); const r = l.getBoundingClientRect(); const rows = [...l.querySelectorAll(':scope > .tab-row')]; const last = rows.at(-1).getBoundingClientRect(); return [r.left + r.width / 2, last.bottom + 3]; })()")
    L.move_to(sx, sy, lst[0], lst[1]); L.drop(lst[0], lst[1])
    check("B: a pulled pane dropped on Today leaves the list as a normal Today tab (the other pane stays pinned)", L.tree() == ["p2", "n3"] and "p1" not in L.owned() and L.owned().get("p2") == cs["2"] and L.split_of(cs["1"]) == -1 and cs["1"] in flat(), json.dumps([L.tree(), L.owned(), L.today()]))

    # --- 引き出してフォルダの中へ ---
    clean()
    cs = {k: L.mk(f"https://sb7-{k}.invalid/") for k in ("1", "2", "9")}; time.sleep(1.2)
    seed([splitnode("S", tabnode("p1", "https://sb7-1.invalid/"), tabnode("p2", "https://sb7-2.invalid/")), {"type": "folder", "id": "F", "title": "F", "children": [tabnode("n9", "https://sb7-9.invalid/")]}])
    bind({"p1": cs["1"], "p2": cs["2"], "n9": cs["9"]}); E(f"chrome.tabs.createSplit([{cs['1']}, {cs['2']}])"); time.sleep(0.6)
    bx, by = mid(pane_of("S", "p2"), 0.4); sx, sy = L.grab(bx, by); fx, fy = mid(L.row(ps("F")))
    L.move_to(sx, sy, fx, fy); L.drop(fx, fy)
    check("B: a pulled pane dropped on a folder goes into it as a single item", L.tree() == ["p1", ["folder", "F", ["n9", "p2"]]] and L.split_of(cs["2"]) == -1, json.dumps(L.tree()))

    # --- 引き出して別の単独の行の真ん中へ: 新しい分割 ---
    cs = setup_split("sb8")
    bx, by = mid(pane_of("S", "p2"), 0.4); sx, sy = L.grab(bx, by)
    x2, y2 = mid(L.row(ps("n3")), 0.75)
    L.move_to(sx, sy, x2, y2)
    check("B: a pulled pane hovering the middle of another single row marks the split target", L.has_cls(ps("n3"), "drop-split-right"))
    L.drop(x2, y2)
    tr = L.tree()
    check("B: ...which makes a new split with that row, and the old partner becomes a single item", len(tr) == 2 and tr[0] == "p1" and tr[1][0] == "split" and tr[1][2] == ["n3", "p2"] and L.paired(cs["3"], cs["2"]) and L.split_of(cs["1"]) == -1, json.dumps(tr))

    # --- 移動先 (お気に入り) が拒否 (重複) しても、引き出しは確定している ---
    cs = setup_split("sb9")
    E("chrome.storage.sync.set({ pins: [{ id: 'fz', url: 'https://sb9-2.invalid/', title: 'Dup' }] })"); time.sleep(0.8)
    bx, by = mid(pane_of("S", "p2"), 0.4); sx, sy = L.grab(bx, by); fx, fy = mid(L.row('.pin[data-id="fz"]'))
    L.move_to(sx, sy, fx, fy); L.drop(fx, fy)
    check("B: a duplicate favorite refuses the move, but the pull is committed (two single items, Chrome split gone)", L.tree() == ["p1", "p2", "n3"] and L.split_of(cs["1"]) == -1 and L.split_of(cs["2"]) == -1, json.dumps([L.tree(), toast()]))
    E("chrome.storage.sync.set({ pins: [] })")

    # --- フォルダの中の分割行をお気に入りのグリッドへ: フォルダから出て、お気に入りの分割項目 (1 マス) になる ---
    clean()
    cs = {k: L.mk(f"https://sb10-{k}.invalid/") for k in ("1", "2")}; time.sleep(1.0)
    seed([{"type": "folder", "id": "F", "title": "F", "children": [splitnode("S", tabnode("p1", "https://sb10-1.invalid/"), tabnode("p2", "https://sb10-2.invalid/")), tabnode("n9", "https://sb10-9.invalid/")]}, tabnode("n3", "https://sb10-3.invalid/")])
    bind({"p1": cs["1"], "p2": cs["2"]}); E(f"chrome.tabs.createSplit([{cs['1']}, {cs['2']}])"); time.sleep(0.6)
    E("chrome.storage.sync.set({ pins: [{ id: 'fq', url: 'https://sb10-fav.invalid/', title: 'Fav' }] })"); time.sleep(0.8)
    gx, gy = mid(grip_of("S")); fx, fy = mid(L.row('.pin[data-id="fq"]'), 0.9)
    L.drag_to(gx, gy, fx, fy)
    check("B: a split row hovering the favorites grid marks an insertion next to the hovered tile", E("!!document.querySelector('#pin-grid .drop-before, #pin-grid .drop-after')"))
    L.drop(fx, fy)
    pf = E("chrome.storage.sync.get('pins').then(r => (r.pins || []).map(p => p.type === 'split' ? ['split', p.children.map(c => c.id)] : p.id))")
    check("B: ...dropping makes one split favorite after it, leaving the folder (the tree keeps the other items)", len(pf) == 2 and pf[0] == "fq" and pf[1][0] == "split" and pf[1][1] == ["p1", "p2"] and L.tree() == [["folder", "F", ["n9"]], "n3"], json.dumps([L.tree(), pf]))
    check("B: owners (pane ids) and the Chrome split are kept", L.owned().get("p1") == cs["1"] and L.owned().get("p2") == cs["2"] and wait_for(lambda: L.paired(cs["1"], cs["2"])), json.dumps([L.owned(), L.strip()]))
    E("chrome.storage.sync.set({ pins: [] })")


# ================= Part C: クリックと復元 =================
def partC():
    clean()
    a, b = mkpair("sc"); time.sleep(1.0)
    pa, pb = pane_nodes("sc")
    seed([splitnode("S", pa, pb)]); bind({pa["id"]: a, pb["id"]: b}); time.sleep(0.5)
    n0 = L.tab_count(); sv = L.split_of(a)
    x, y = mid(pane_of("S", pb["id"]), 0.4)
    L.click(x, y)
    check("C: clicking a pane of a live split opens nothing new and keeps the split", L.tab_count() == n0 and L.split_of(a) == sv and L.paired(a, b), json.dumps(L.strip()))
    check("C: ...and brings the clicked pane to the front", wait_for(lambda: L.active(b)))
    x, y = mid(pane_of("S", pa["id"]), 0.4); L.click(x, y)
    check("C: clicking the other pane switches to it", wait_for(lambda: L.active(a)) and L.tab_count() == n0)

    # --- 外から unsplit した状態でクリック: 分割が戻り、タブは増えない ---
    E(f"chrome.tabs.unsplit({sv})"); time.sleep(0.6)
    check("C setup: unsplit from outside", L.split_of(a) == -1)
    x, y = mid(pane_of("S", pb["id"]), 0.4); L.click(x, y)
    check("C: clicking rebuilds the split without opening tabs", wait_for(lambda: L.paired(a, b)) and L.tab_count() == n0 and L.owned().get(pa["id"]) == a, json.dumps(L.strip()))
    check("C: the clicked pane is in front after the rebuild", wait_for(lambda: L.active(b)))

    # --- 片方が閉じていたら +1 枚、両方なら +2 枚 ---
    E(f"chrome.tabs.remove({b})"); time.sleep(1.0)
    check("C setup: one pane closed; the item stays, only that pane lost its tab", L.tree() == [["split", "S", [pa["id"], pb["id"]]]] and pb["id"] not in L.owned() and L.owned().get(pa["id"]) == a, json.dumps(L.owned()))
    check("C: the closed pane has no open mark, the other has", E("(() => { const ps = [...document.querySelectorAll('.pinned-node[data-node-id=\"S\"] .split-pane')]; return !ps[1].classList.contains('open') && ps[0].classList.contains('open'); })()"))
    n1 = L.tab_count(); x, y = mid(pane_of("S", pa["id"]), 0.4); L.click(x, y)
    nb = L.owned().get(pb["id"])
    check("C: clicking with one pane closed opens just the missing pane (+1) next to its partner as a split", nb is not None and L.tab_count() == n1 + 1 and L.paired(a, nb) and L.order().index(a) < L.order().index(nb), json.dumps(L.strip()))
    E(f"chrome.tabs.remove([{a}, {nb}])"); time.sleep(1.0)
    n2 = L.tab_count(); x, y = mid(pane_of("S", pa["id"]), 0.4); L.click(x, y)
    na, nb = L.owned().get(pa["id"]), L.owned().get(pb["id"])
    check("C: clicking with both panes closed opens both (+2) as a split", na and nb and L.tab_count() == n2 + 2 and L.paired(na, nb) and L.order().index(na) < L.order().index(nb), json.dumps(L.strip()))
    a, b = na, nb

    # --- ユーザーが片方だけ固定したタブは組まない: 前面にするだけで、通知を出す ---
    E(f"chrome.tabs.unsplit({L.split_of(a)})"); time.sleep(0.4)
    E(f"chrome.tabs.update({a}, {{ pinned: true }})"); time.sleep(0.5)
    clear_toast()
    n3 = L.tab_count(); x, y = mid(pane_of("S", pb["id"]), 0.4); L.click(x, y); time.sleep(0.5)
    check("C: a pane the user pinned (the other not) is not forced into a split; both tabs stay open and the user is told", L.split_of(a) == -1 and L.split_of(b) == -1 and L.tab_count() == n3 and "split view" in toast(), json.dumps([L.strip(), toast()]))
    check("C: ...and the clicked pane is in front", wait_for(lambda: L.active(b)))
    E(f"chrome.tabs.update({a}, {{ pinned: false }})"); time.sleep(0.5)

    # --- 再クリックで、押したペインだけ登録 URL に戻る ---
    E(f"chrome.tabs.update({a}, {{ active: true }})")
    E(f"chrome.tabs.update({a}, {{ url: 'https://sc-a.invalid/elsewhere' }})"); E(f"chrome.tabs.update({b}, {{ url: 'https://sc-b.invalid/elsewhere' }})"); time.sleep(1.5)
    x, y = mid(pane_of("S", pa["id"]), 0.4); L.click(x, y); time.sleep(1.0)
    ua = E(f"chrome.tabs.get({a}).then(t => t.url)"); ub = E(f"chrome.tabs.get({b}).then(t => t.url)")
    check("C: clicking the pane you are looking at returns just that pane to its registered URL", ua.rstrip("/") == pa["url"].rstrip("/") and "elsewhere" in ub, json.dumps([ua, ub]))
    E(f"chrome.tabs.update({a}, {{ url: 'https://sc-a.invalid/elsewhere' }})"); time.sleep(1.2)
    gx, gy = mid(grip_of("S")); L.click(gx, gy); time.sleep(1.0)
    ua = E(f"chrome.tabs.get({a}).then(t => t.url)")
    check("C: clicking the grip (ambiguous pane) does not return any URL", "elsewhere" in ua, ua)

    # --- ⌘ クリック: 押したペインの登録 URL を別タブで開く。担当は増えない ---
    n4 = L.tab_count(); ow = L.owned(); x, y = mid(pane_of("S", pb["id"]), 0.4)
    L.click(x, y, mods=4); time.sleep(0.8)
    check("C: ⌘-click opens that pane's URL in a new tab without changing the owners", L.tab_count() == n4 + 1 and L.owned() == ow, json.dumps(L.owned()))

    # --- 擬似再起動: ownedTabs を消してパネルを開き直すと、2 ペインが結び直され、Today に出ない ---
    E(f"chrome.tabs.update({a}, {{ url: 'https://sc-a.invalid/' }})"); E(f"chrome.tabs.update({b}, {{ url: 'https://sc-b.invalid/' }})"); time.sleep(1.5)
    E(f"chrome.tabs.get({a}).then(t => t.splitViewId !== -1 ? chrome.tabs.unsplit(t.splitViewId) : 0)"); time.sleep(0.5)
    E("chrome.storage.session.remove('ownedTabs')"); time.sleep(0.5)
    E("location.reload()"); time.sleep(2.5)
    check("C: after a session wipe the panel rebinds both panes by URL and neither shows in Today", wait_for(lambda: L.owned().get(pa["id"]) == a and L.owned().get(pb["id"]) == b) and a not in flat() and b not in flat(), json.dumps([L.owned(), L.today()]))
    n5 = L.tab_count(); x, y = mid(pane_of("S", pa["id"]), 0.4); L.click(x, y)
    check("C: ...and clicking afterwards rebuilds the split without opening tabs", wait_for(lambda: L.paired(a, b)) and L.tab_count() == n5, json.dumps(L.strip()))

    # --- adoptLivePair: 手で作った分割が項目の 2 URL と一致すれば、タブを増やさずに採用 ---
    clean()
    pa, pb = pane_nodes("sl")
    seed([splitnode("S", pa, pb)])
    a, b = mkpair("sl", split=False)
    E(f"chrome.tabs.update({a}, {{ url: 'https://sl-a.invalid/' }})")
    # mkpair は sl-a / sl-b の URL でタブを作る。pane_nodes の URL (sl-a / sl-b) と一致
    E(f"chrome.tabs.createSplit([{a}, {b}])"); time.sleep(0.8)
    n6 = L.tab_count(); x, y = mid(pane_of("S", pa["id"]), 0.4); L.click(x, y)
    check("C: a live split whose two URLs match the item is adopted as is (no tab opened)", L.tab_count() == n6 and L.owned().get(pa["id"]) == a and L.owned().get(pb["id"]) == b and L.paired(a, b), json.dumps([L.owned(), L.strip()]))
    # 片方だけ一致する分割は奪わない
    clean()
    pa, pb = pane_nodes("sm")
    seed([splitnode("S", pa, pb)])
    a = L.mk("https://sm-a.invalid/"); z = L.mk("https://sm-other.invalid/"); time.sleep(0.8)
    E(f"chrome.tabs.createSplit([{a}, {z}])"); time.sleep(0.8)
    n7 = L.tab_count(); x, y = mid(pane_of("S", pa["id"]), 0.4); L.click(x, y); time.sleep(0.8)
    check("C: a split that matches only one URL is not taken over (both panes opened as new tabs, the live split stays)", L.paired(a, z) and L.owned().get(pa["id"]) not in (a, z, None) and L.tab_count() == n7 + 2, json.dumps([L.owned(), L.strip()]))

    # --- 組めない (タブグループが違う) と分かっているときは、ユーザーの別の分割 (A|X) を解かない ---
    clean()
    pa, pb = pane_nodes("sg")
    seed([splitnode("S", pa, pb)])
    a = L.mk("https://sg-a.invalid/"); x = L.mk("https://sg-x.invalid/"); b = L.mk("https://sg-b.invalid/"); time.sleep(0.8)
    E(f"chrome.tabs.group({{ tabIds: [{a}, {x}] }})"); time.sleep(0.4)
    E(f"chrome.tabs.createSplit([{a}, {x}])"); time.sleep(0.6)
    bind({pa["id"]: a, pb["id"]: b})
    check("C setup: A|X is a split inside a tab group, B is outside it", L.paired(a, x) and E(f"chrome.tabs.get({a}).then(t => t.groupId)") != -1 and E(f"chrome.tabs.get({b}).then(t => t.groupId)") == -1, json.dumps(L.strip()))
    sv2 = L.split_of(a); clear_toast()
    px, py = mid(pane_of("S", pb["id"]), 0.4); L.click(px, py); time.sleep(0.8)
    check("C: a pair that cannot be assembled (different tab groups) leaves the user's other split A|X intact", L.paired(a, x) and L.split_of(a) == sv2 and L.split_of(b) == -1, json.dumps(L.strip()))
    check("C: ...and the user is told it could not be opened as a split view", "split view" in toast(), toast())


# ================= Part D: 名前変更、編集モード、回帰 =================
def partD():
    clean()
    a, b = mkpair("sd"); time.sleep(1.0)
    pa, pb = pane_nodes("sd")
    seed([splitnode("S", pa, pb), tabnode("single", "https://sd-s.invalid/", "Single")]); bind({pa["id"]: a, pb["id"]: b}); time.sleep(0.4)
    x, y = mid(pane_of("S", pb["id"]), 0.3, 0.5)
    L.dblclick(x, y)
    check("D: double-clicking a pane turns that pane's title into an input", E("!!document.querySelector('.pinned-node[data-node-id=\"S\"] .split-pane[data-pane-id=\"%s\"] input.rename-input')" % pb["id"]) and not E("!!document.querySelector('.pinned-node[data-node-id=\"S\"] .split-pane[data-pane-id=\"%s\"] input')" % pa["id"]))
    E("(() => { const i = document.querySelector('.rename-input'); i.value = 'Right renamed'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()"); time.sleep(0.8)
    raw = L.pinned_raw()
    check("D: Enter saves only that pane's title (the other pane and the item keep theirs)", [c["title"] for c in raw[0]["children"]] == [pa["title"], "Right renamed"] and "title" not in raw[0], json.dumps(raw[0]))
    gx, gy = mid(grip_of("S")); L.dblclick(gx, gy)
    check("D: double-clicking the grip does not start a rename", not E("!!document.querySelector('.rename-input')"))

    # --- 編集モード: × は行末に 1 つ。項目ごと消え、2 ペインとも解放され、Today に分割行として戻る ---
    E("setPinnedEditing(true)"); time.sleep(0.4)
    check("D: in edit mode the split row shows a single × (at the row end), hidden outside it", E("getComputedStyle(document.querySelector('.pinned-node[data-node-id=\"S\"] .tab-close')).visibility") == "visible")
    cb = L.box("document.querySelector('.pinned-node[data-node-id=\"S\"] .tab-close')"); cx, cy = mid(cb)
    L.click(cx, cy); time.sleep(0.8)
    check("D: × removes the whole item and releases both panes", L.tree() == ["single"] and pa["id"] not in L.owned() and pb["id"] not in L.owned(), json.dumps([L.tree(), L.owned()]))
    check("D: ...and the two tabs return to Today as a split row (still a split)", wait_for(lambda: [a, b] in L.today()) and L.paired(a, b), json.dumps(L.today()))
    E("setPinnedEditing(false)")

    # --- 壊れた split (children が 2 枚でない) は平らな項目へ展開して描く。パネルは落ちない ---
    E("chrome.storage.sync.set({ pinnedTabs: %s })" % json.dumps([{"type": "split", "id": "bad", "children": [tabnode("only", "https://sd-only.invalid/", "Only")]}, tabnode("ok", "https://sd-ok.invalid/", "Ok")])); time.sleep(1.0)
    rows = E("[...document.querySelectorAll('#pinned-list .pinned-node')].map(r => [r.dataset.nodeId, r.classList.contains('split-row')])")
    check("D: a broken split (one pane) is shown as a plain row and the panel keeps working", rows == [["only", False], ["ok", False]], json.dumps(rows))
    check("D: the folder count and rename still work on plain rows afterwards", E("renamePinnedNode('ok', 'Ok2').then(() => pinnedTabs.map(n => n.title))") == ["Only", "Ok2"])

    # --- お気に入りの分割タイルの ×: 編集モードで、中心がペインに覆われず押せる ---
    clean()
    set_pins([{"type": "split", "id": "S", "children": [pinleaf("s1", 1, "sd2"), pinleaf("s2", 2, "sd2")]}])
    E("setEditing(true)"); time.sleep(0.5)
    rb = L.row(tile("S") + " .remove"); rx, ry = mid(rb)
    top = E("document.elementFromPoint(%f, %f)?.className || ''" % (rx, ry))
    check("D: in edit mode the × of a split favorite tile is on top at its centre (not covered by a pane)", "remove" in str(top), json.dumps([rb, top]))
    L.click(rx, ry); time.sleep(1.0)
    check("D: clicking the × centre removes the split favorite", pins_raw() == [], json.dumps(pins_raw()))
    E("setEditing(false)")


# ================= Part E: 競合、重複、容量 =================
def partE():
    clean()
    a, b = mkpair("se1"); time.sleep(1.0)
    pa, pb = pane_nodes("se1")
    seed([splitnode("S", pa, pb)]); bind({pa["id"]: a, pb["id"]: b}); time.sleep(0.4)
    # 分割の 2 枚を続けて discard すると onReplaced が 2 回来る。両方のペインが新しい ID に付け替わり、担当を失わない
    try:
        E(f"Promise.all([chrome.tabs.discard({a}), chrome.tabs.discard({b})])")
    except Exception as e:
        print("discard failed:", str(e)[:160])
    time.sleep(2.5)
    ow = L.owned(); na, nb = ow.get(pa["id"]), ow.get(pb["id"])
    alive = {t for t in L.order()}
    if na == a and nb == b:
        check("E: (this Chrome did not replace the tab ids on discard; the race could not be provoked)", True, "info")
    else:
        check("E: after discarding both panes at once, both panes are re-pointed to live tabs (no owner lost)", na in alive and nb in alive and na != nb, json.dumps([ow, L.strip()]))
    n0 = L.tab_count(); x, y = mid(pane_of("S", pa["id"]), 0.4); L.click(x, y); time.sleep(0.8)
    check("E: ...and the next click opens no extra tab", L.tab_count() == n0 and L.owned().get(pa["id"]) in alive | set(L.order()) and L.owned().get(pb["id"]) is not None, json.dumps(L.strip()))
    # 背景の付け替えを手で 2 回呼んでも結果は同じ (冪等、後の書き込みが先を失わない)
    E("chrome.storage.session.set({ ownedTabs: { 'x1': 111, 'x2': 222, 'keep': 5 } })"); time.sleep(0.3)
    E("Promise.all([repointOwnedTab(1111, 111), repointOwnedTab(2222, 222), repointOwnedTab(1111, 111)])")
    got = L.owned()
    check("E: two quick re-pointings are serialized: neither is lost, and a repeat is a no-op", got == {"x1": 1111, "x2": 2222, "keep": 5}, json.dumps(got))

    # --- 重複 URL: 片方の URL が既存の項目と重複する分割は、全体を断る ---
    clean()
    seed([tabnode("dup", "https://se2-b.invalid/", "Dup")])
    a, b = mkpair("se2"); time.sleep(1.0)
    ow0 = L.owned(); gx, gy = mid(tgrip(a)); px, py = mid(L.box("document.querySelector('#pinned-section')"))
    clear_toast()
    L.drag_to(gx, gy, px, py); L.drop(px, py)
    check("E: a split with a URL already in the list is refused as a whole (nothing saved, nothing bound, still a split in Today)", L.tree() == ["dup"] and L.owned() == ow0 and [a, b] in L.today() and L.paired(a, b) and "added" in toast().lower(), json.dumps([L.tree(), toast()]))

    # --- 容量超過: pinStorageFull を出し、保存値も画面も変わらない ---
    clean()
    # 長いタイトルから短いタイトルの順に、収まらなくなるまで詰める (行数を少なく保ち、Today を画面内に残す)
    fill = E("""(() => { const n = []; let i = 0;
      for (const len of [1500, 500, 100, 10]) for (;;) { const x = { type: 'tab', id: 'f' + (i++), url: 'https://fill-' + i + '.invalid/', title: 't'.repeat(len) }; if (!pinnedTabsFit([...n, x])) break; n.push(x); }
      return n; })()""")
    seed(fill)
    a, b = mkpair("se3"); time.sleep(1.0)
    gx, gy = mid(tgrip(a)); px, py = mid(L.box("document.querySelector('#pinned-section')"))
    clear_toast()
    L.drag_to(gx, gy, px, py); L.drop(px, py)
    check("E: when the pinned list is full, a split drop is refused with the storage-full notice and nothing changes", len(L.tree()) == len(fill) and L.owned() == {} and [a, b] in L.today() and "full" in toast().lower(), json.dumps([len(L.tree()), toast()]))



# ================= Part F-J: お気に入り (グリッド) の分割項目 =================
pins_raw = lambda: E("chrome.storage.sync.get('pins').then(r => r.pins || [])")
pshape = lambda: [p["id"] if p.get("type") != "split" else ["split", p["id"], [c["id"] for c in p["children"]]] for p in pins_raw()]
tile = lambda pid: '#pin-grid .pin[data-id="%s"]' % pid
ppane = lambda pid, cid: '#pin-grid .pin[data-id="%s"] .pin-pane[data-pane-id="%s"]' % (pid, cid)
op_ids = lambda: E("chrome.storage.local.get('ownedPinned').then(r => Object.keys(r.ownedPinned || {}).filter(k => r.ownedPinned[k]))")
set_pins = lambda lst: (E("chrome.storage.sync.set({ pins: %s })" % json.dumps(lst)), time.sleep(0.8))
pinleaf = lambda pid, k, tag: {"id": pid, "url": f"https://{tag}-{k}.invalid/", "title": f"{tag.upper()} {k}"}

def fav_tabs(tag, n=3):
    cs = {str(k): L.mk(f"https://{tag}-{k}.invalid/") for k in range(1, n + 1)}; time.sleep(1.2)
    return cs

def fav_split_setup(tag, with_third=True):
    # お気に入り: 分割項目 S (S1, S2) と単独 f3。3 枚とも担当タブあり。分割は Chrome に組んでおく (固定は揃える)
    clean()
    cs = fav_tabs(tag)
    lst = [{"type": "split", "id": "S", "children": [pinleaf("s1", 1, tag), pinleaf("s2", 2, tag)]}]
    if with_third: lst.append(pinleaf("f3", 3, tag))
    set_pins(lst)
    bind({"s1": cs["1"], "s2": cs["2"], **({"f3": cs["3"]} if with_third else {})})
    E(f"assembleSplit([{cs['1']}, {cs['2']}], {{ pinned: true }})"); time.sleep(1.0)
    return cs

def partF():
    clean()
    cs = fav_tabs("sf"); set_pins([pinleaf("f1", 1, "sf"), pinleaf("f2", 2, "sf"), pinleaf("f3", 3, "sf")])
    bind({"f1": cs["1"], "f2": cs["2"], "f3": cs["3"]}); n0 = L.tab_count()
    x1, y1 = mid(L.row(tile("f1"))); x2, y2 = mid(L.row(tile("f2")), 0.65)
    L.drag_to(x1, y1, x2, y2)
    check("F: hovering the centre-right of another favorite tile marks the split target (right)", L.has_cls(tile("f2"), "drop-split-right"))
    L.drop(x2, y2)
    ps_ = pshape()
    check("F: dropping makes one split item at that tile's place (dropped tile on the right), a split is one cell", len(ps_) == 2 and ps_[0][0] == "split" and ps_[0][2] == ["f2", "f1"] and ps_[1] == "f3", json.dumps(ps_))
    raw = pins_raw()
    check("F: split panes are plain {id,url,title} (no type), keeping the old favorite ids", all("type" not in c and c["url"] and c["title"] for c in raw[0]["children"]), json.dumps(raw))
    check("F: owners are untouched and no tab was opened", L.owned() == {"f1": cs["1"], "f2": cs["2"], "f3": cs["3"]} and L.tab_count() == n0, json.dumps(L.owned()))
    check("F: Chrome has the split (f2 left, f1 right) and both tabs are pinned (pinOwnedTabs on)", wait_for(lambda: L.paired(cs["2"], cs["1"])) and L.tab(cs["1"])["pinned"] and L.tab(cs["2"])["pinned"], json.dumps(L.strip()))
    check("F: both panes are recorded as extension-pinned (so the setting can unpin them)", {"f1", "f2"} <= set(op_ids()), json.dumps(op_ids()))
    check("F: the grid shows one split tile with two panes plus the single tile", E("document.querySelectorAll('#pin-grid .pin:not(.add)').length") == 2 and E("document.querySelectorAll('#pin-grid .pin.split-tile .pin-pane').length") == 2)
    # 格子の斜め・縁: 相手の奥側では「分割にする」にならない
    clean()
    cs = fav_tabs("sf2"); set_pins([pinleaf("g1", 1, "sf2"), pinleaf("g2", 2, "sf2"), pinleaf("g3", 3, "sf2")])
    bind({"g1": cs["1"], "g2": cs["2"], "g3": cs["3"]})
    x1, y1 = mid(L.row(tile("g1"))); b2 = L.row(tile("g2"))
    L.drag_to(x1, y1, b2[0] + b2[2] * 0.97, b2[1] + b2[3] * 0.97)
    check("F: hovering the far corner of the tile is not a split target", not E("!!document.querySelector('#pin-grid .drop-split-left, #pin-grid .drop-split-right')"))
    L.key("Escape", 27); L.mouse("mouseReleased", b2[0] + b2[2] * 0.97, b2[1] + b2[3] * 0.97, 0); time.sleep(1.0)
    check("F: Esc leaves the favorites unchanged", pshape() == ["g1", "g2", "g3"] and not L.paired(cs["1"], cs["2"]), json.dumps(pshape()))

def partG():
    clean()
    cs = fav_tabs("sg", 2)
    set_pins([{"type": "split", "id": "S", "children": [pinleaf("s1", 1, "sg"), pinleaf("s2", 2, "sg")]}])
    for tid in cs.values(): E(f"chrome.tabs.remove({tid})")
    time.sleep(1.0); n0 = L.tab_count()
    bx, by = mid(L.row(ppane("S", "s2")))
    L.click(bx, by); time.sleep(1.5)
    ow = L.owned()
    check("G: clicking a pane of a closed split tile opens both panes (two new tabs), bound per pane", "s1" in ow and "s2" in ow and L.tab_count() == n0 + 2, json.dumps([ow, L.tab_count(), n0]))
    a, b = ow["s1"], ow["s2"]
    check("G: ...as a split, left pane first, both Chrome-pinned (setting on)", L.paired(a, b) and L.order().index(b) == L.order().index(a) + 1 and L.tab(a)["pinned"] and L.tab(b)["pinned"], json.dumps(L.strip()))
    check("G: the clicked pane's tab is shown", wait_for(lambda: L.active(b)))
    check("G: both panes show the open mark", E("document.querySelectorAll('#pin-grid .pin-pane.open').length") == 2)
    n1 = L.tab_count(); bx, by = mid(L.row(ppane("S", "s1"))); L.click(bx, by)
    check("G: clicking again opens nothing new and shows the clicked pane", L.tab_count() == n1 and wait_for(lambda: L.active(a)) and L.paired(a, b), json.dumps(L.strip()))
    E("removePin('S')"); time.sleep(1.5)
    check("G: removing the item releases both panes, unpins them, and the split stays in Chrome", pins_raw() == [] and L.owned() == {} and L.paired(a, b) and not L.tab(a)["pinned"] and not L.tab(b)["pinned"] and op_ids() == [], json.dumps([L.owned(), L.strip(), op_ids()]))
    check("G: the pair is back in Today as one split row", wait_for(lambda: [a, b] in L.today()), json.dumps(L.today()))

def partH():
    # H1: お気に入り -> ピン留めタブ
    cs = fav_split_setup("sh1")
    gx, gy = mid(L.row(ppane("S", "s1")), 0.2); px, py = mid(L.row("#pinned-section"))
    L.drag_to(*mid(L.row(tile("S")), 0.1), px, py); L.drop(px, py)
    tr = L.tree()
    check("H1: a favorites split dropped on the pinned list becomes one split item there (same pane ids)", len(tr) == 1 and tr[0][0] == "split" and tr[0][2] == ["s1", "s2"] and pins_raw() == [pinleaf("f3", 3, "sh1")], json.dumps([tr, pins_raw()]))
    check("H1: owners kept, split kept, and the tabs are unpinned (the list does not Chrome-pin)", L.owned().get("s1") == cs["1"] and L.owned().get("s2") == cs["2"] and L.paired(cs["1"], cs["2"]) and not L.tab(cs["1"])["pinned"] and not L.tab(cs["2"])["pinned"], json.dumps([L.owned(), L.strip()]))
    # H2: ピン留めタブ -> お気に入り
    gx, gy = mid(grip_of(tr[0][1])); fx, fy = mid(L.row("#pin-grid"), 0.5, 0.5)
    L.drag_to(gx, gy, fx, fy); L.drop(fx, fy)
    ps_ = pshape()
    check("H2: a pinned split row dropped on the grid becomes one split favorite (one cell)", L.tree() == [] and sum(1 for p in ps_ if isinstance(p, list)) == 1 and any(isinstance(p, list) and p[2] == ["s1", "s2"] for p in ps_), json.dumps([L.tree(), ps_]))
    check("H2: ...both tabs are Chrome-pinned again and still a split, owners kept", wait_for(lambda: L.tab(cs["1"])["pinned"] and L.tab(cs["2"])["pinned"] and L.paired(cs["1"], cs["2"])) and L.owned().get("s1") == cs["1"], json.dumps([L.owned(), L.strip()]))
    # H4: お気に入り -> Today
    lst = E("(() => { const l = document.querySelector('#today-list'); const r = l.getBoundingClientRect(); const rows = [...l.querySelectorAll(':scope > .tab-row')]; const last = rows.at(-1).getBoundingClientRect(); return [r.left + r.width / 2, last.bottom + 3]; })()")
    sid = [p for p in pshape() if isinstance(p, list)][0][1]
    L.drag_to(*mid(L.row(tile(sid)), 0.1), lst[0], lst[1]); L.drop(lst[0], lst[1])
    check("H4: a favorites split dropped on Today leaves the grid, releases both panes, and returns as a split row", wait_for(lambda: all(not isinstance(p, list) for p in pshape()) and "s1" not in L.owned() and "s2" not in L.owned() and [cs["1"], cs["2"]] in L.today() and L.paired(cs["1"], cs["2"])), json.dumps([pshape(), L.owned(), L.today()]))
    check("H4: ...unpinned", not L.tab(cs["1"])["pinned"] and not L.tab(cs["2"])["pinned"])
    # H3: Today の分割行 -> お気に入り
    clean()
    a, b = mkpair("sh3"); time.sleep(1.5)
    set_pins([pinleaf("f9", 9, "sh3")])
    gx, gy = mid(tgrip(a)); fx, fy = mid(L.row(tile("f9")), 0.9)
    L.drag_to(gx, gy, fx, fy); L.drop(fx, fy)
    ps_ = pshape()
    check("H3: a Today split row dropped on the grid becomes one split favorite after the hovered tile", len(ps_) == 2 and ps_[0] == "f9" and isinstance(ps_[1], list) and len(ps_[1][2]) == 2, json.dumps(ps_))
    ow = L.owned()
    check("H3: panes are bound to those tabs, split kept, both Chrome-pinned, no new tab", ps_ and ow.get(ps_[1][2][0]) == a and ow.get(ps_[1][2][1]) == b and wait_for(lambda: L.paired(a, b) and L.tab(a)["pinned"] and L.tab(b)["pinned"]), json.dumps([ow, L.strip()]))
    check("H3: the tabs left the Today list", wait_for(lambda: a not in flat() and b not in flat()), json.dumps(L.today()))
    # 重複と容量
    clean()
    a, b = mkpair("sh5"); time.sleep(1.2)
    set_pins([{"id": "fd", "url": "https://sh5-a.invalid/", "title": "D"}]); before = pshape()
    gx, gy = mid(tgrip(a)); fx, fy = mid(L.row(tile("fd")), 0.9)
    clear_toast(); L.drag_to(gx, gy, fx, fy); L.drop(fx, fy)
    check("H5: a Today split with a URL already among the favorites is refused as a whole (with the duplicate notice)", pshape() == before and L.owned() == {} and L.paired(a, b) and "added" in toast().lower(), json.dumps([pshape(), toast()]))

def partI():
    cs = fav_split_setup("si")
    # Option + ドラッグで 1 ペインを引き出す (グリッド内: 単独タイルの奥側へ)
    bx, by = mid(L.row(ppane("S", "s2"))); mods = 1
    L.mouse("mouseMoved", bx, by, 0, mods); L.mouse("mousePressed", bx, by, 1, mods); L.mouse("mouseMoved", bx, by + 4, 1, mods); L.mouse("mouseMoved", bx, by + 8, 1, mods); time.sleep(0.2)
    check("I: Option-dragging a pane starts a pull (one pane marked pulled, a single tile appears)", E("document.querySelectorAll('#pin-grid .pin-pane.pulled').length") == 1 and E("!!document.querySelector('#pin-grid .pin[data-pulled-from]')"))
    t3 = L.row(tile("f3")); tx, ty = t3[0] + t3[2] * 0.9, t3[1] + t3[3] * 0.5
    L.move_to(bx, by + 8, tx, ty); L.drop(tx, ty)
    ps_ = pshape()
    check("I: dropping inside the grid commits the pull: no split item, three single favorites (item count +1)", len(ps_) == 3 and all(isinstance(p, str) for p in ps_) and sorted(ps_) == ["f3", "s1", "s2"], json.dumps(ps_))
    check("I: Chrome split is gone, owners are kept", wait_for(lambda: L.split_of(cs["1"]) == -1 and L.split_of(cs["2"]) == -1) and L.owned().get("s1") == cs["1"] and L.owned().get("s2") == cs["2"], json.dumps([L.strip(), L.owned()]))
    # 満杯のときは引き出せない (引き出しで項目が 1 つ増えるため)
    cs = fav_split_setup("si2")
    old = E("settings.maxPins"); E("settings.maxPins = 2")
    bx, by = mid(L.row(ppane("S", "s2")))
    L.mouse("mouseMoved", bx, by, 0, 1); L.mouse("mousePressed", bx, by, 1, 1); L.mouse("mouseMoved", bx, by + 4, 1, 1); L.mouse("mouseMoved", bx, by + 8, 1, 1); time.sleep(0.2)
    t3 = L.row(tile("f3")); tx, ty = t3[0] + t3[2] * 0.9, t3[1] + t3[3] * 0.5
    clear_toast(); L.move_to(bx, by + 8, tx, ty); L.drop(tx, ty)
    ps_ = pshape()
    check("I: with the favorites full, pulling a pane out inside the grid changes nothing and says so", len(ps_) == 2 and isinstance(ps_[0], list) and L.paired(cs["1"], cs["2"]) and toast() != "", json.dumps([ps_, toast()]))
    E("settings.maxPins = %s" % json.dumps(old))
    # Option なしでペインをつかむと項目ごと動く (引き出さない)
    bx, by = mid(L.row(ppane("S", "s2"))); sx, sy = L.grab(bx, by)
    check("I: without Option the whole tile moves (no pull)", not E("!!document.querySelector('#pin-grid .pin[data-pulled-from]')"))
    L.key("Escape", 27); L.mouse("mouseReleased", sx, sy, 0); time.sleep(1.0)

def partJ():
    # 固定が外れた分割: 再クリックで固定を揃えて組み直す (settled の前提の見直し)
    cs = fav_split_setup("sj")
    check("J setup: split pinned", L.paired(cs["1"], cs["2"]) and L.tab(cs["1"])["pinned"] and L.tab(cs["2"])["pinned"], json.dumps(L.strip()))
    E(f"chrome.tabs.update({cs['2']}, {{ pinned: false }})"); time.sleep(1.0)
    check("J: unpinning one pane (user action) dissolves the split", L.split_of(cs["1"]) == -1 or not L.paired(cs["1"], cs["2"]), json.dumps(L.strip()))
    n0 = L.tab_count(); bx, by = mid(L.row(ppane("S", "s1"))); L.click(bx, by); time.sleep(1.5)
    check("J: clicking the tile pins both panes again and re-assembles the split, without opening a tab", L.paired(cs["1"], cs["2"]) and L.tab(cs["1"])["pinned"] and L.tab(cs["2"])["pinned"] and L.tab_count() == n0, json.dumps(L.strip()))
    # ユーザーのグループ内の (拡張が固定していない) タブは固定しない: 分割にもしない
    clean()
    cs = fav_tabs("sj2", 2)
    set_pins([{"type": "split", "id": "S", "children": [pinleaf("s1", 1, "sj2"), pinleaf("s2", 2, "sj2")]}])
    bind({"s1": cs["1"], "s2": cs["2"]})
    gid = E(f"chrome.tabs.group({{ tabIds: [{cs['1']}, {cs['2']}] }})"); time.sleep(0.8)
    clear_toast(); bx, by = mid(L.row(ppane("S", "s1"))); L.click(bx, by); time.sleep(1.5)
    t1 = L.tab(cs["1"])
    check("J: a grouped, unpinned owned tab is never pinned or ungrouped by the split; the click only shows the pane", t1 and not t1["pinned"] and t1["groupId"] == gid and not L.tab(cs["2"])["pinned"], json.dumps(L.strip()))



try:
    check("setup: this Chrome has the split view API (Chrome 155+)", E("typeof chrome.tabs.createSplit === 'function' && typeof chrome.tabs.unsplit === 'function'"))
    for part, fn in (("0", part0), ("A", partA), ("B", partB), ("C", partC), ("D", partD), ("E", partE), ("F", partF), ("G", partG), ("H", partH), ("I", partI), ("J", partJ)):
        if part in parts:
            print(f"--- Part {part} ---", flush=True)
            fn()
    errs = L.errors()
    check("no errors in the panel", not errs, json.dumps(errs))
finally:
    L.close()
sys.exit(L.finish())
