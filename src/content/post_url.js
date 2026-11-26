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
/* exported __btFindPostUrl, __btFindPostForSrc, __btRememberThumb */

// 拡大表示を開くために押した縮小表示の記録（Misskey の拡大表示は投稿の外の層に出るため）
// { key: クエリを除いたリンク先, post: 投稿のアドレス, at: 押した時刻 }
var __btLastThumb = (typeof __btLastThumb !== "undefined") ? __btLastThumb : null;
var __BT_THUMB_TTL_MS = 10 * 60 * 1000;

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
  if (rec && rec.key === key && Date.now() - rec.at < __BT_THUMB_TTL_MS) return rec.post;
  // 投稿の外の画像はどのサイトでもここを通るため、URL の解析の前に先頭の一致で絞る（リンクの多いページでの負荷を抑える）
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (typeof href !== "string" || href.indexOf(key) !== 0) continue;
    if (__btStripQuery(href) !== key) continue;
    const p = __btWalkToPost(a);
    if (p) return p;
  }
  return null;
}

// 画像の要素から投稿のアドレスを求める。取れなければ、ページ（枠）のアドレスが投稿を指していればそれ、無ければ null
function __btFindPostUrl(el) {
  try {
    if (el && el.nodeType === 1) {
      const p = el.closest("article") ? __btWalkToPost(el) : __btPostFromSameImageLink(el);
      if (p) return p;
    }
    return __btPostUrlFromHref(location.href);
  } catch (_) {
    return null;
  }
}

// 画像のアドレスから要素を探して投稿のアドレスを求める（枠の中の右クリック用）
function __btFindPostForSrc(srcUrl) {
  try {
    if (typeof srcUrl === "string" && /^https?:/i.test(srcUrl)) {
      for (const img of document.images) {
        if (img.currentSrc === srcUrl || img.src === srcUrl) return __btFindPostUrl(img);
      }
    }
    return __btPostUrlFromHref(location.href);
  } catch (_) {
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
