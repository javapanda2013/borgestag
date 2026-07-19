// BorgesTag 共有再生コア：GIF(canvas+Worker)＋音声追従（GROUP-142 派生・共有部品化 Stage 3、v1.50.0）
//
// settings の履歴タイルにしか無かった「GIF を Worker で decode → canvas 描画 → audio.currentTime から
// フレーム逆算して追従」を、viewer / settings ライトボックス / modal 履歴タブ にも同じ仕組みで持ち込む
// ための再生コア。双子経路の非対称（片方だけ追従を実装し忘れる）を構造的に不可能にするのが目的。
//
// classic script（realm ローカル）で window.BTGifAudio を公開。modal は窓ごとに別 realm なので、
// 各窓が独自の Worker・player レジストリを持つ＝窓の独立性は自動的に満たされる。
//
// 責務分割（プランの確定方針#2「再生コアだけ共有」）：
//   コア（本ファイル）＝ 共有 Worker 起動 / INIT / READY / FRAME 描画 / 自走 rAF / 追従 rAF / 逆算 /
//                       後勝ち token / rebind・unbind の「機構」
//   呼び出し側に残す = pool/LRU、IntersectionObserver（可視域）、ライトボックス連動、DOM ツリー破棄、
//                     バイト源（getBuffer で注入）、音声ボタン DOM、いつ rebind/unbind するかの「方針」
//
// 3 層 gate は AND 合成（足し算しない）：実効 drawable = canvas!=null && !document.hidden && isDrawable()
//   viewer/modal は isDrawable 省略（既定 true）＝ canvas && !hidden
//   settings は isDrawable=() => tile.visible!==false && !tile.lbSuspended を注入（現行の実効条件と一致）

"use strict";

(function () {
  const WORKER_URL = "src/decoders/gif-decoder.worker.js";

  // 共有 Worker と player レジストリ（この realm 内で単一。settings は 1 Worker を多重化する既存構造を踏襲）。
  let _worker = null;
  let _players = new Map(); // id -> player state
  let _seq = 0;

  function _effectiveDrawable(p) {
    if (p.canvas == null) return false;
    if (p.suspended) return false; // pause()（ライトボックス連動等）中は描画も追従の副作用も止める
    if (typeof document !== "undefined" && document.hidden) return false;
    return p.isDrawable ? !!p.isDrawable() : true;
  }

  function _getWorker() {
    if (_worker) return _worker;
    try {
      _worker = new Worker(browser.runtime.getURL(WORKER_URL), { type: "module" });
      _worker.onmessage = _onWorkerMessage;
      _worker.onerror = (err) => { console.warn("[gif-audio-player] worker error", err); };
    } catch (err) {
      console.warn("[gif-audio-player] worker 起動失敗", err);
      _worker = null;
    }
    return _worker;
  }

  function _onWorkerMessage(e) {
    const msg = e.data || {};
    const p = _players.get(msg.id);
    if (!p) {
      if (msg.bitmap?.close) try { msg.bitmap.close(); } catch (_) {}
      return;
    }
    if (msg.type === "READY") {
      p.ready = true;
      p.frameCount = msg.frameCount || 1;
      p.dims = msg.dims;
      p.delays = Array.isArray(msg.delays) ? msg.delays : null;
      p.totalDelayMs = msg.totalDelayMs || 0;
      if (msg.dims && p.canvas) {
        p.canvas.width = msg.dims.width;
        p.canvas.height = msg.dims.height;
      }
      p.currentIndex = 0;
      if (p.canvas && _worker) {
        _worker.postMessage({ type: "REQ_FRAME", id: p.id, index: 0 });
      }
      if (typeof p.onReady === "function") {
        try { p.onReady({ dims: p.dims, frameCount: p.frameCount, totalDelayMs: p.totalDelayMs, delays: p.delays }); } catch (_) {}
      }
    } else if (msg.type === "FRAME") {
      if (p.canvas && msg.bitmap && p.ctx) {
        try { p.ctx.drawImage(msg.bitmap, 0, 0); } catch (err) { console.warn("[gif-audio-player] drawImage 失敗", err); }
      }
      if (msg.bitmap?.close) try { msg.bitmap.close(); } catch (_) {}
      // 追従駆動中は自走の再スケジュールを組まない（フレーム要求は追従 rAF が audio.currentTime から発行）。
      if (p.driveMode === "audio") {
        p.currentIndex = msg.index;
        return;
      }
      const nextIndex = (msg.index + 1) % (p.frameCount || 1);
      p.currentIndex = nextIndex;
      if (p.canvas) {
        if (!_effectiveDrawable(p)) {
          p.paused = true;
        } else {
          p.paused = false;
          if (p.timerId) { try { clearTimeout(p.timerId); } catch (_) {} }
          p.timerId = setTimeout(() => {
            if (_players.get(p.id) !== p) return;
            if (p.canvas == null) return;         // dormant 化されたら停止
            if (!_effectiveDrawable(p)) { p.paused = true; return; }
            if (_worker) _worker.postMessage({ type: "REQ_FRAME", id: p.id, index: nextIndex });
          }, msg.delay || 100);
        }
      }
    } else if (msg.type === "ERROR") {
      console.warn("[gif-audio-player] session error", msg.id, msg.message);
      if (typeof p.onError === "function") { try { p.onError(new Error(msg.message)); } catch (_) {} }
      _destroy(p);
    }
  }

  // 自走再開（可視域・タブ・rebind の条件は _effectiveDrawable に委譲。追従中は発行しない）。
  function _resumeIfNeeded(p) {
    if (!p || !p.paused || !p.ready || !p.canvas) return;
    if (p.driveMode === "audio") return;
    if (!_effectiveDrawable(p)) return;
    p.paused = false;
    // 既存の in-flight self タイマーを解いてから 1 発だけ REQ_FRAME（IO/lb/rebind から resume が
    // 重なった際の二重駆動 churn を防ぐ。FRAME ハンドラが単一 timer に収束させるが未然に潰す）。
    if (p.timerId) { try { clearTimeout(p.timerId); } catch (_) {} p.timerId = null; }
    if (_worker) _worker.postMessage({ type: "REQ_FRAME", id: p.id, index: p.currentIndex || 0 });
  }

  function _followStop(p) {
    if (!p) return;
    if (p.followRafId) { try { cancelAnimationFrame(p.followRafId); } catch (_) {} p.followRafId = null; }
    if (p.driveMode !== "audio") return;
    p.driveMode = "self";
    p.audioToken = null;
    // 自走復帰：paused 扱いにして resume 経路（ready/canvas/drawable の全チェック）へ委譲。
    p.paused = true;
    _resumeIfNeeded(p);
  }

  function _nowMs() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
  }

  // delay 表と GIF 内経過 tMs（0..totalDelayMs）から表示フレーム index を逆算（純関数＝harness 検証可）。
  function _pickFrameIndex(delays, totalDelayMs, tMs) {
    const t = totalDelayMs > 0 ? (tMs % totalDelayMs) : 0;
    let acc = 0, idx = delays.length - 1;
    for (let i = 0; i < delays.length; i++) {
      acc += (delays[i] || 100);
      if (t < acc) { idx = i; break; }
    }
    return idx;
  }

  // 両方待ち協調ループ：音声と GIF のどちらが長くても途中で切らず、長い方の完了で両方を
  // 0 へ戻して一緒に再開する GIF 内クロックを算出する。副作用は audio への currentTime/play/loop 制御。
  //   - 音声 ≧ GIF（音声 master）：audio.loop=true で音声が自走ループし、GIF は音声時刻に追従（modulo）。
  //     音声がループ端で 0 に戻ると GIF も frame0 に揃う＝協調リセット。
  //   - GIF > 音声（GIF master）：audio.loop=false。音声を 1 回鳴らし切った後、GIF を実時計で続行させ、
  //     GIF が totalDelayMs に達したら音声を 0 から再生し直して両方を揃える。
  // 戻り：GIF 内クロック(ms)。null 時は「描画スキップ」（バッファ中など）。
  function _coordinatedGifClock(p, audio) {
    const gifTotal = p.totalDelayMs;
    const audioDur = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration * 1000 : null;
    // audioDur が不明（メタ未ロード）なら音声 master 既定
    const gifMaster = (audioDur != null) && (gifTotal > audioDur + 1);
    audio.loop = !gifMaster;

    if (!gifMaster) {
      p.audioEndedAt = null;
      return audio.currentTime * 1000;
    }
    // GIF master
    if (!audio.ended) {
      p.audioEndedAt = null;
      return audio.currentTime * 1000;
    }
    if (p.audioEndedAt == null) p.audioEndedAt = _nowMs();
    let gifClock = audioDur + (_nowMs() - p.audioEndedAt);
    if (gifClock >= gifTotal) {
      // GIF 完走 → 両方リセット（音声を頭から鳴らし直す）
      try { audio.currentTime = 0; const pr = audio.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (_) {}
      p.audioEndedAt = null;
      gifClock = 0;
    }
    return gifClock;
  }

  // audio を時間源に GIF フレームを駆動（時間源が音声/実時計なのでズレ非累積・両方待ち協調ループ込み）。
  // token = 駆動権。後勝ち：新しい followAudio が別 token を入れると旧ループは自己終了する。
  function _followAudio(p, audio, token) {
    if (!p.ready || !Array.isArray(p.delays) || !(p.totalDelayMs > 0)) return;
    if (p.followRafId) { try { cancelAnimationFrame(p.followRafId); } catch (_) {} p.followRafId = null; }
    p.audioToken = token;
    p.driveMode = "audio";
    p.audioEndedAt = null;
    p.suspended = false; // 新規追従開始は再生中＝suspend 解除（pause 残置で tick が空回りしないように）
    if (p.timerId) { try { clearTimeout(p.timerId); } catch (_) {} p.timerId = null; }
    const tick = () => {
      if (_players.get(p.id) !== p) return;                       // destroy 済
      if (p.driveMode !== "audio" || p.audioToken !== token) return; // 後勝ち／自走復帰済み
      // 停止検知：ユーザー/システム起因の pause（＝paused かつ ended でない）を一元検知。
      // GIF master の「音声が鳴り切って待機中」は ended=true なので停止扱いにしない（協調ループ継続）。
      if (audio.paused && !audio.ended) { _followStop(p); return; }
      // suspend 中（pause()＝ライトボックス連動等）は追従ループを生かしたまま副作用を止める。
      // これを飛ばさないと GIF master の待機フェーズで _coordinatedGifClock が audio.play() を発火し、
      // 背後でサムネ音声が鳴り続ける（F2）。resume() で suspended を解けば次 tick から再開。
      if (p.suspended) { p.followRafId = requestAnimationFrame(tick); return; }
      const gifClock = _coordinatedGifClock(p, audio);
      if (_effectiveDrawable(p) && gifClock != null) {
        const idx = _pickFrameIndex(p.delays, p.totalDelayMs, gifClock);
        // 重複排除：フレーム番号が変わった時だけ REQ_FRAME（GIF 実 fps＝10Hz 程度に抑える）。
        if (idx !== p.currentIndex) {
          p.currentIndex = idx;
          if (_worker) { try { _worker.postMessage({ type: "REQ_FRAME", id: p.id, index: idx }); } catch (_) {} }
        }
      }
      p.followRafId = requestAnimationFrame(tick);
    };
    p.followRafId = requestAnimationFrame(tick);
  }

  function _destroy(p) {
    if (!p) return;
    if (p.timerId) { try { clearTimeout(p.timerId); } catch (_) {} p.timerId = null; }
    if (p.followRafId) { try { cancelAnimationFrame(p.followRafId); } catch (_) {} p.followRafId = null; }
    _players.delete(p.id);
    if (_worker) { try { _worker.postMessage({ type: "DESTROY", id: p.id }); } catch (_) {} }
    p.canvas = null; p.ctx = null;
  }

  /**
   * GIF 再生プレイヤーを 1 つ生成する。getBuffer でバイト源を注入（thumbId/path をコアは知らない）。
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas    描画先（後で rebind 可）
   * @param {() => Promise<ArrayBuffer|null>} o.getBuffer  GIF バイナリ供給（IDB blob / ローカルファイル 等）
   * @param {() => boolean} [o.isDrawable]  画面固有の描画可否 gate（省略時 true）
   * @param {(info)=>void} [o.onReady]      READY 到達（dims/frameCount/totalDelayMs/delays）
   * @param {(err)=>void}  [o.onError]      失敗（INIT 不能・Worker 不能・decode error）。呼び出し側で img fallback する
   * @returns {{id:number, start:Function, pause:Function, resume:Function,
   *            followAudio:Function, unfollow:Function, getCanvas:Function,
   *            rebind:Function, unbind:Function, destroy:Function,
   *            isReady:Function, isFollowing:Function, getInfo:Function}}
   */
  function createGifPlayer(o) {
    const id = ++_seq;
    const canvas = o.canvas;
    const p = {
      id,
      canvas,
      ctx: canvas ? canvas.getContext("2d") : null,
      ready: false, frameCount: 0, dims: null,
      currentIndex: 0, timerId: null,
      visible: true, paused: false, suspended: false,
      driveMode: "self", delays: null, totalDelayMs: 0, audioToken: null, followRafId: null,
      isDrawable: (typeof o.isDrawable === "function") ? o.isDrawable : null,
      onReady: o.onReady || null,
      onError: o.onError || null,
    };
    _players.set(id, p);

    // 非同期でバイト源を取得して INIT（失敗は onError で呼び出し側の img fallback に委ねる）。
    (async () => {
      let buffer;
      try {
        buffer = await o.getBuffer();
      } catch (err) {
        if (typeof p.onError === "function") { try { p.onError(err); } catch (_) {} }
        _destroy(p); return;
      }
      if (!buffer) {
        if (typeof p.onError === "function") { try { p.onError(new Error("GIF バイナリを取得できませんでした")); } catch (_) {} }
        _destroy(p); return;
      }
      // 破棄済みなら INIT を送らない（P1-A）：rapid create/destroy（LB ナビ連打・modal 再描画）で
      // destroy() の DESTROY が INIT より先に Worker へ着くと、後着の INIT が誰にも回収されない
      // 孤児 session（パース済 GIF＋rawFrames）を作り、長命 realm で累積リークする。
      if (_players.get(id) !== p) return;
      const w = _getWorker();
      if (!w) {
        if (typeof p.onError === "function") { try { p.onError(new Error("Worker を起動できませんでした")); } catch (_) {} }
        _destroy(p); return;
      }
      try {
        w.postMessage({ type: "INIT", id, gifBuffer: buffer }, [buffer]);
      } catch (err) {
        if (typeof p.onError === "function") { try { p.onError(err); } catch (_) {} }
        _destroy(p);
      }
    })();

    return {
      id,
      isReady: () => p.ready,
      // 追従駆動中か（協調ループの自然 end pause を「停止」と誤認しないための判定に使う。F1）
      isFollowing: () => p.driveMode === "audio" && p.followRafId != null && !p.suspended,
      getInfo: () => ({ ready: p.ready, dims: p.dims, frameCount: p.frameCount, totalDelayMs: p.totalDelayMs, delays: p.delays }),
      getCanvas: () => p.canvas, // 呼び出し側の「rebind 済みなら unbind しない」ガード用（sess.canvas!==cv → player.getCanvas()!==cv）
      start: () => { p.suspended = false; p.paused = true; _resumeIfNeeded(p); },
      pause: () => {
        // suspend：自走 timer を消し、追従ループの副作用（協調ループの audio.play() 等）も止める（F2）。
        // 追従ループ自体は生かしておき、resume() で suspended を解けば次 tick から再開する。
        p.suspended = true;
        p.paused = true;
        if (p.timerId) { try { clearTimeout(p.timerId); } catch (_) {} p.timerId = null; }
      },
      resume: () => { p.suspended = false; p.paused = true; _resumeIfNeeded(p); },
      followAudio: (audio, token) => _followAudio(p, audio, token),
      // token 指定時は「その token が駆動中の時だけ」解除（同一サムネ共有で別 entry が後勝ち駆動中に、
      // 削除された entry の解放が生存側の追従を誤って止めないため）。無指定は従来どおり無条件解除。
      unfollow: (token) => {
        if (token !== undefined && p.audioToken !== token) return;
        _followStop(p);
      },
      // rebind：dormant（canvas=null）→ 別 canvas へ貼り直して描画継続（pool の再表示）。
      rebind: (newCanvas) => {
        if (p.timerId) { try { clearTimeout(p.timerId); } catch (_) {} p.timerId = null; }
        p.canvas = newCanvas;
        p.ctx = newCanvas ? newCanvas.getContext("2d") : null;
        p.suspended = false; // suspend 中の再描画→rebind で suspended が残ると描画停止したままになる
        p.paused = false;
        if (newCanvas && p.dims) {
          newCanvas.width = p.dims.width;
          newCanvas.height = p.dims.height;
        }
        if (_worker && p.ready && newCanvas) {
          _worker.postMessage({ type: "REQ_FRAME", id: p.id, index: p.currentIndex });
        }
      },
      // unbind：canvas を外して dormant 化（Worker session は保持）。self-drive は止める。
      unbind: () => {
        if (p.timerId) { try { clearTimeout(p.timerId); } catch (_) {} p.timerId = null; }
        p.canvas = null; p.ctx = null; p.paused = true;
      },
      destroy: () => _destroy(p),
    };
  }

  window.BTGifAudio = { createGifPlayer };
})();
