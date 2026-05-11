// ============================================================================
// BorgesTag ESLint 設定（GROUP-74-eslint、Tier 1 構造的予防）
//
// 主目的：v1.46.14 closure scope バグ（暗黙的 global 化、undefined function 呼出）
// および silent failure 系の機械的検出。
//
// ルール選定の根拠：
// - no-undef (error)：top-level で declare されていない変数への代入や、
//   未定義関数の呼出を検出。v1.46.14 で listener が saveHistory / renderHistory に
//   到達できなかった bug を、コード書く瞬間に lint で fail させる。
// - no-redeclare (error)：同一 scope での重複 declare を検出。
// - no-empty (warn, allowEmptyCatch=true)：空ブロックを警告（catch だけは慣用的に
//   許容）。完全 silent な if/else block に気付ける。
// - no-unused-vars (warn)：未使用変数の警告。コード品質維持。
//
// 既存の Firefox WebExtension globals は globals セクションで読込可とする。
// プロジェクト固有 helpers（escapeHtml, JSZip 等）も globals に追加。
// ============================================================================

const browserGlobals = {
  // Firefox WebExtension API
  browser:           "readonly",
  chrome:            "readonly",
  // 標準 DOM / Browser API
  window:            "readonly",
  document:          "readonly",
  console:           "readonly",
  navigator:         "readonly",
  location:          "readonly",
  history:           "readonly",
  localStorage:      "readonly",
  sessionStorage:    "readonly",
  indexedDB:         "readonly",
  IDBKeyRange:       "readonly",
  Blob:              "readonly",
  File:              "readonly",
  FileReader:        "readonly",
  FormData:          "readonly",
  URL:               "readonly",
  URLSearchParams:   "readonly",
  XMLHttpRequest:    "readonly",
  fetch:             "readonly",
  Headers:           "readonly",
  Request:           "readonly",
  Response:          "readonly",
  AbortController:   "readonly",
  WebSocket:         "readonly",
  Worker:            "readonly",
  SharedWorker:      "readonly",
  ServiceWorker:     "readonly",
  // Image / Canvas / Audio / Video
  Image:             "readonly",
  ImageBitmap:       "readonly",
  createImageBitmap: "readonly",
  ImageData:         "readonly",
  OffscreenCanvas:   "readonly",
  HTMLImageElement:  "readonly",
  HTMLCanvasElement: "readonly",
  HTMLElement:       "readonly",
  HTMLInputElement:  "readonly",
  Element:           "readonly",
  Node:              "readonly",
  CSS:               "readonly",
  ShadowRoot:        "readonly",
  // Audio / Video / Media
  Audio:             "readonly",
  Video:             "readonly",
  MediaRecorder:     "readonly",
  MediaStream:       "readonly",
  MediaSource:       "readonly",
  AudioContext:      "readonly",
  // Crypto / Web Workers
  crypto:            "readonly",
  Worker:            "readonly",
  postMessage:       "readonly",
  // Timers
  setTimeout:        "readonly",
  clearTimeout:      "readonly",
  setInterval:       "readonly",
  clearInterval:     "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame:  "readonly",
  requestIdleCallback:   "readonly",
  cancelIdleCallback:    "readonly",
  queueMicrotask:        "readonly",
  // Encoding
  TextEncoder:       "readonly",
  TextDecoder:       "readonly",
  atob:              "readonly",
  btoa:              "readonly",
  // Base
  globalThis:        "readonly",
  Promise:           "readonly",
  Map:               "readonly",
  Set:               "readonly",
  WeakMap:           "readonly",
  WeakSet:           "readonly",
  WeakRef:           "readonly",
  Symbol:            "readonly",
  Proxy:             "readonly",
  Reflect:           "readonly",
  Intl:              "readonly",
  // Events
  Event:             "readonly",
  EventTarget:       "readonly",
  CustomEvent:       "readonly",
  MessageEvent:      "readonly",
  KeyboardEvent:     "readonly",
  MouseEvent:        "readonly",
  PointerEvent:      "readonly",
  TouchEvent:        "readonly",
  WheelEvent:        "readonly",
  InputEvent:        "readonly",
  // Misc
  alert:             "readonly",
  confirm:           "readonly",
  prompt:            "readonly",
  performance:       "readonly",
  ResizeObserver:    "readonly",
  IntersectionObserver: "readonly",
  MutationObserver:  "readonly",
  DOMParser:         "readonly",
  XPathResult:       "readonly",
  // Vendor libraries（src/vendor/ で読込済の global 名）
  JSZip:             "readonly",
  gifshot:           "readonly",
  // プロジェクト固有 helpers（settings.js setupHistoryTab 内 local 関数を window 経由で expose、
  // modal.js でも top-level に同名関数を定義）。"writable" にすることで複数ファイルでの
  // 局所定義（redeclare）を許容しつつ、未定義参照（no-undef）は引き続き検出する設定。
  showBusyModal:        "writable",
  hideBusyModal:        "writable",
  completeBusyModal:    "writable",
  updateBusyMessage:    "writable",
  _histAudioPlayingId:  "writable",
  _histAudioStopCurrent: "writable",
};

module.exports = [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: browserGlobals,
    },
    rules: {
      "no-undef": "error",
      // builtinGlobals=false：globals に登録した名前を local 関数で再定義しても error にしない。
      // showBusyModal / completeBusyModal / hideBusyModal は modal.js / settings.js 双方で
      // top-level 定義されており、これを globals としても認識する都合上必要。
      "no-redeclare": ["error", { "builtinGlobals": false }],
      "no-empty": ["warn", { "allowEmptyCatch": true }],
      "no-unused-vars": ["warn", {
        "args": "none",
        "varsIgnorePattern": "^_",
        "argsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
      }],
    },
  },
  {
    // vendor / worker / decoders は本リポジトリ管理外コード or 別 module 体系（Web Worker ES modules）、lint 対象外
    ignores: ["src/vendor/**", "src/worker/**", "src/decoders/**"],
  },
];
