/**
 * post_url.js（GROUP-171）
 * 押した画像が属する投稿のアドレスを求める。対象は X（/〈ユーザー〉/status/〈番号〉）と
 * Misskey（表示中のホストの /notes/〈ID〉）だけで、取れないときは null を返す。
 * 呼び出し側は null のとき今までどおり開いているページのアドレスを使う。
 *
 * 読み込み経路は 2 つ：
 *   ① manifest.json の content_scripts で content.js より先に最上位のページへ入る
 *   ② デックの枠（iframe）の中で右クリックしたときだけ、background.js が
 *      tabs.executeScript でその枠に入れる（all_frames は使わない＝ホバーのボタンを枠ごとに出さない）
 * ② で同じ枠へ何度入っても壊れないよう、トップレベルは function 宣言と var だけにする
 * （const / let は 2 回目の読み込みで再宣言の例外になる）。
 */
/* exported __btFindPostUrl, __btFindPostForSrc, __btRememberThumb, __btNoteFrame, __btLastHow */

// 拡大表示を開くために押した縮小表示の記録（Misskey の拡大表示は投稿の外の層に出るため）
// { key: クエリを除いたリンク先, post: 投稿のアドレス, at: 押した時刻 }
var __btLastThumb = (typeof __btLastThumb !== "undefined") ? __btLastThumb : null;
var __BT_THUMB_TTL_MS = 10 * 60 * 1000;
// 直前にポインタが乗った枠（iframe の要素）。X のデック独自の拡大表示は最上位のページに出て、
// 投稿は列の枠の中にあるため、拡大表示の画像の投稿を探すときにこの枠を先に探す（content.js の mouseover から記録）
var __btLastFrame = (typeof __btLastFrame !== "undefined") ? __btLastFrame : null;
// 直前に求めた投稿のアドレスを、どこから取ったか（取れなかったか）。設定画面のログに出すため
var __btLastHow = "";

// http(s) のアドレスからクエリとハッシュを除く。それ以外（data: / blob: など）は null
function __btStripQuery(u) {
  try {
    const x = new URL(u, location.href);
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    return x.origin + x.pathname;
  } catch (_) {
    return null;
  }
}

// リンク先が投稿のアドレスなら、正規の形（クエリ・/photo/N などを除いたもの）で返す
function __btPostUrlFromHref(href) {
  let u;
  try { u = new URL(href, location.href); } catch (_) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i.test(u.hostname)) {
    const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    return m ? `${u.origin}/${m[1]}/status/${m[2]}` : null;
  }
  // Misskey は自分のサーバーの投稿だけを採る（他のサイトの /notes/ を拾わないよう同じオリジンに限る）
  if (u.origin === location.origin) {
    const m = u.pathname.match(/^\/notes\/([A-Za-z0-9]+)\/?$/);
    return m ? `${u.origin}/notes/${m[1]}` : null;
  }
  return null;
}

// node の中にある投稿日時のリンク（time を子に持つ a）のうち、最初に投稿を指すもの
function __btPostLinkIn(node) {
  const times = node.querySelectorAll("time");
  for (const t of times) {
    const a = t.closest("a[href]");
    if (!a || !node.contains(a)) continue;
    const p = __btPostUrlFromHref(a.href);
    if (p) return p;
  }
  return null;
}

// el から祖先へ 1 段ずつたどり、投稿日時のリンクを最初に含む段の投稿を採る。
// article に着いても無ければ打ち切る（近い順にすると、引用の投稿でも画像の持ち主の投稿になる）
function __btWalkToPost(el) {
  const article = el.closest("article");
  if (!article) return null;
  for (let n = el; n; n = n.parentElement) {
    const p = __btPostLinkIn(n);
    if (p) return p;
    if (n === article) break;
  }
  return null;
}

// 投稿の外にある画像（Misskey の拡大表示）：押した縮小表示の記録か、同じ画像を指すリンクから求める
function __btPostFromSameImageLink(el) {
  const key = __btStripQuery(el.currentSrc || el.src || "");
  if (!key) return null;
  const rec = __btLastThumb;
  if (rec && rec.key === key && Date.now() - rec.at < __BT_THUMB_TTL_MS) {
    __btLastHow = "押した縮小表示の記録から";
    return rec.post;
  }
  // 投稿の外の画像はどのサイトでもここを通るため、URL の解析の前に先頭の一致で絞る（リンクの多いページでの負荷を抑える）
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (typeof href !== "string" || href.indexOf(key) !== 0) continue;
    if (__btStripQuery(href) !== key) continue;
    const p = __btWalkToPost(a);
    if (p) {
      __btLastHow = "同じ画像を指すリンクから";
      return p;
    }
  }
  return null;
}

// X の画像（pbs.twimg.com/media/〈ID〉）の ID を返す。X は表示の大きさでクエリ（name=small / orig など）や
// 拡張子の付け方が変わるため、同じ画像かどうかは ID で比べる
function __btXMediaId(u) {
  try {
    const x = new URL(u, location.href);
    if (x.hostname !== "pbs.twimg.com") return null;
    const m = x.pathname.match(/^\/media\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

// doc の中から、同じ ID の X の画像（img か、背景に指定した要素）を探し、その投稿を採る
function __btPostForMediaIdIn(doc, id) {
  const needle = "/media/" + id;
  const imgs = doc.images;
  for (let i = 0; i < imgs.length; i++) {
    const s = imgs[i].currentSrc || imgs[i].src || "";
    if (s.indexOf(needle) < 0 || __btXMediaId(s) !== id) continue;
    const p = __btWalkToPost(imgs[i]);
    if (p) return p;
  }
  // id は英数字と _ - だけなので、属性セレクタにそのまま入れてよい。
  // 部分一致で拾った後、ID が前方一致しただけの別の画像を除くため、style の中の ID を取り出して完全一致で比べる
  const styled = doc.querySelectorAll('[style*="' + needle + '"]');
  for (let i = 0; i < styled.length; i++) {
    const st = styled[i].getAttribute("style") || "";
    const re = /\/media\/([A-Za-z0-9_-]+)/g;
    let m, same = false;
    while ((m = re.exec(st)) !== null) {
      if (m[1] === id) { same = true; break; }
    }
    if (!same) continue;
    const p = __btWalkToPost(styled[i]);
    if (p) return p;
  }
  return null;
}

// X のデック独自の拡大表示（最上位のページ）の画像：同じオリジンの列の枠の中から同じ画像を探して投稿を採る。
// 直前にポインタが乗った枠を先に探し、複数あれば最初に見つけた投稿。
// 別のオリジンの枠は中身を読めない（contentDocument が null か例外）ので飛ばす
function __btPostFromFrames(el) {
  if (window !== window.top) return null;
  const id = __btXMediaId(el.currentSrc || el.src || "");
  if (!id) return null;
  const frames = Array.prototype.slice.call(document.querySelectorAll("iframe"));
  const last = __btLastFrame;
  const li = last ? frames.indexOf(last) : -1;
  if (li > 0) {
    frames.splice(li, 1);
    frames.unshift(last);
  }
  for (const f of frames) {
    let doc = null;
    try { doc = f.contentDocument; } catch (_) { doc = null; }
    if (!doc) continue;
    try {
      const p = __btPostForMediaIdIn(doc, id);
      if (p) return p;
    } catch (_) { /* 読めない枠は飛ばす */ }
  }
  return null;
}

// content.js の mouseover（最上位のページ）から、ポインタが乗った枠を記録する
function __btNoteFrame(frameEl) {
  __btLastFrame = frameEl;
}

// 画像の要素から投稿のアドレスを求める。取れなければ、ページ（枠）のアドレスが投稿を指していればそれ、無ければ null
function __btFindPostUrl(el) {
  __btLastHow = "";
  let reason = ""; // 取れなかったとき、どこまで探したかをログに出す
  try {
    if (el && el.nodeType === 1) {
      if (el.closest("article")) {
        const p = __btWalkToPost(el);
        if (p) {
          __btLastHow = "投稿の枠から";
          return p;
        }
        reason = "投稿の枠の中に投稿日時のリンクが無い";
      } else {
        const p = __btPostFromSameImageLink(el);
        if (p) return p;
        // 開いているページが投稿なら、枠を探すより先にそれを採る（X の通常の拡大表示は /status/〈番号〉/photo/1 で、
        // 画像の持ち主の投稿を指す）。枠を探すのは、デックのようにページのアドレスが投稿でないときだけ
        const q = __btPostUrlFromHref(location.href);
        if (q) {
          __btLastHow = "開いているページのアドレスから";
          return q;
        }
        const f = __btPostFromFrames(el);
        if (f) {
          __btLastHow = "列の枠にある同じ画像から";
          return f;
        }
        reason = "投稿の外の画像で、同じ画像のリンクも列の枠の同じ画像も見つからない";
      }
    }
    return __btPostFromPageUrl(reason);
  } catch (_) {
    __btLastHow = "求める途中で失敗（開いているページのアドレスを使う）";
    return null;
  }
}

// ページ（枠）のアドレスが投稿を指していればそれを返す。reason は取れなかったときにログへ添える探した範囲
function __btPostFromPageUrl(reason) {
  const q = __btPostUrlFromHref(location.href);
  __btLastHow = q ? "開いているページのアドレスから"
    : `取れない（${reason ? reason + "。" : ""}開いているページのアドレスを使う）`;
  return q;
}

// 画像のアドレスから要素を探して投稿のアドレスを求める（枠の中の右クリック用）
function __btFindPostForSrc(srcUrl) {
  __btLastHow = "";
  try {
    if (typeof srcUrl === "string" && /^https?:/i.test(srcUrl)) {
      for (const img of document.images) {
        if (img.currentSrc === srcUrl || img.src === srcUrl) return __btFindPostUrl(img);
      }
    }
    return __btPostFromPageUrl("押した画像がページの中に見つからない");
  } catch (_) {
    __btLastHow = "求める途中で失敗（開いているページのアドレスを使う）";
    return null;
  }
}

// 押したリンクが投稿の中にあれば、拡大表示で使うために記録する（content.js の click 捕捉から呼ぶ）
function __btRememberThumb(target) {
  try {
    if (!target || target.nodeType !== 1) return;
    const a = target.closest("a[href]");
    if (!a) return;
    if (__btPostUrlFromHref(a.href)) return; // 投稿そのもののリンクは対象外
    const key = __btStripQuery(a.href);
    if (!key) return;
    const post = __btWalkToPost(a);
    if (post) __btLastThumb = { key, post, at: Date.now() };
  } catch (_) {}
}
