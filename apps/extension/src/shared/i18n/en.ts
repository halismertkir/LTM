/**
 * UI strings (English is the reference). `tr.ts` must define exactly the same keys with
 * the same `{placeholders}` — enforced by the type of `tr` and by test/i18n.test.ts.
 */
export const en = {
  // toolbar
  "action.title.idle": "LTM",
  "action.title.recording": "LTM — recording",
  "action.title.recordingDegraded": "LTM — recording (reconnecting, audio is buffered)",
  "action.title.consent": "LTM — consent needed before recording",
  "action.title.paused": "LTM — capture paused for your account",
  "action.title.error": "LTM — error",
  "action.title.notPaired": "LTM — not paired",
  "action.title.meeting": "LTM — meeting detected: click to record",

  // popup: state headline
  "state.notPaired": "Not paired",
  "state.notPaired.sub": "Connect this browser to your LTM server first.",
  "state.consent": "Blocked: consent needed",
  "state.consent.sub": "Accept the consent documents before anything can be recorded.",
  "state.paused": "Paused",
  "state.paused.sub": "Capture is paused for your whole account. Resume it in the dashboard.",
  "state.idle": "Idle",
  "state.idle.sub": "Nothing is being recorded.",
  "state.error": "Error",
  "state.listening.tab": "Listening to this tab",
  "state.listening.otherTab": "Listening to a tab",
  "state.listening.mic": "Listening to microphone",
  "state.listening.tabMic": "Listening to this tab + microphone",
  "state.listening.otherTabMic": "Listening to a tab + microphone",
  "state.connecting": "Connecting to your server…",
  "state.reconnecting": "Reconnecting — {seconds} s of audio buffered",
  "state.stopping": "Stopping…",

  // popup: controls
  "popup.recordTab": "Record this tab",
  "popup.stopTab": "Stop tab",
  "popup.recordMic": "Record microphone",
  "popup.stopMic": "Stop microphone",
  "popup.copyNotice": "Copy “I’m recording” notice",
  "popup.copied": "Copied — paste it into the meeting chat.",
  "popup.copyFailed": "Could not copy. Select the text below and copy it manually.",
  "popup.dashboard": "Open dashboard",
  "popup.settings": "Settings",
  "popup.pair": "Pair this browser",
  "popup.reviewConsent": "Review consent",
  "popup.dismiss": "Dismiss",
  "popup.captionWaiting": "Waiting for speech…",
  "popup.captionLabel": "Live caption",
  "popup.elapsed": "Elapsed",
  "popup.shortcut": "Shortcut: {shortcut}",
  "popup.micWithTab": "Your microphone is recorded together with tab audio (see settings).",
  "popup.restrictedTab": "This page cannot be recorded.",

  // errors
  "error.unauthorized": "This browser was removed from your LTM account. Pair it again.",
  "error.consent_required": "Your server requires consent before recording.",
  "error.ingest_paused": "Capture is paused for your account.",
  "error.unsupported_protocol":
    "Your LTM server speaks a different protocol version. Update the extension or the server.",
  "error.needs_invocation":
    "Chrome only lets an extension record a tab after you click its toolbar icon (or press its shortcut) on that tab.",
  "error.restricted_tab": "Browser pages, the Web Store and other extensions cannot be recorded.",
  "error.mic_denied": "Microphone access is not allowed. Grant it on the settings page.",
  "error.capture_failed": "Could not start recording: {detail}",
  "error.server_unreachable": "Cannot reach your LTM server.",
  "error.stream_error": "The server stopped the stream: {detail}",

  // content-script banner
  "banner.question": "Record this meeting with LTM?",
  "banner.start": "Start",
  "banner.notNow": "Not now",
  "banner.never": "Never on this site",
  "banner.needsClick":
    "Chrome needs one click on the LTM icon in the toolbar (or {shortcut}) before a tab can be recorded.",
  "banner.started": "LTM is recording this meeting. Let the others know.",
  "banner.close": "Close",

  // options: general
  "options.title": "LTM settings",
  "options.intro":
    "LTM records the audio of browser meetings (and optionally your microphone) and sends it to your own LTM server, which turns it into transcripts, notes and memories.",

  // options: pairing
  "pair.heading": "Server connection",
  "pair.serverUrl": "Server address",
  "pair.serverUrl.placeholder": "https://ltm.example.org",
  "pair.code": "Pairing code",
  "pair.code.placeholder": "K7QF-2MXD (or paste the ltm://pair link)",
  "pair.code.help":
    "Create a code in the dashboard under Devices → Pair a device. It is valid for 10 minutes.",
  "pair.deviceName": "Name of this browser",
  "pair.submit": "Pair",
  "pair.checking": "Checking the server…",
  "pair.pairing": "Pairing…",
  "pair.permissionExplain":
    "Chrome will ask to let LTM talk to {origin}. That is your server; LTM needs it to send audio.",
  "pair.permissionDenied": "Without access to {origin} the extension cannot talk to your server.",
  "pair.insecure":
    "This address uses plain http on a non-local host: your device token and recordings would travel unencrypted. Use https unless this is a trusted private network.",
  "pair.protocolMismatch":
    "Protocol mismatch: the server speaks version {server}, this extension speaks version {client}. Update whichever is older.",
  "pair.notLtm": "No LTM server answered at this address.",
  "pair.serverOk": "LTM server {version} (protocol {protocol}).",
  "pair.badCode":
    "The pairing code was not accepted. Codes are single-use and expire after 10 minutes.",
  "pair.failed": "Pairing failed: {detail}",
  "pair.paired": "Paired with {server} as “{device}” for {user}.",
  "pair.unpair": "Un-pair this browser",
  "pair.unpairConfirm": "Forget the device token? You will need a new pairing code to reconnect.",
  "pair.unpaired": "Un-paired. The token was deleted from this browser.",
  "pair.revokeHint":
    "To revoke the token on the server as well, remove this device in the dashboard.",

  // options: consent
  "consent.heading": "Consent",
  "consent.satisfied": "All required documents are accepted.",
  "consent.required":
    "Your server requires you to accept these documents before anything is recorded.",
  "consent.checkbox": "I have read and accept “{title}”.",
  "consent.accept": "Accept",
  "consent.accepted": "Thank you — consent recorded.",
  "consent.versionMismatch":
    "The server asks for version {server} of “{title}”, but this extension contains version {local}. Accept it in the dashboard or update the extension.",
  "consent.unavailable": "Pair this browser first.",
  "consent.loadFailed": "Could not load your consent status: {detail}",

  // options: microphone
  "mic.heading": "Microphone",
  "mic.explain":
    "To record your own voice (at the desk, or in meetings where you wear headphones) Chrome must allow this extension to use the microphone. The microphone is only on while LTM shows “REC”.",
  "mic.grant": "Allow microphone",
  "mic.granted": "Microphone access is allowed.",
  "mic.denied":
    "Microphone access is blocked. Click the icon at the right of the address bar on this page (or open Chrome's site settings for this extension) to allow it.",
  "mic.prompt": "Not decided yet.",

  // options: preferences
  "prefs.heading": "Preferences",
  "prefs.autoOffer": "Offer to record on meeting sites (Google Meet, Zoom, Teams)",
  "prefs.autoOffer.help":
    "Shows a small banner when a call starts. Nothing is recorded until you start it.",
  "prefs.micWithTab": "Record my microphone together with tab audio",
  "prefs.micWithTab.help":
    "Recommended: with headphones the tab audio does not contain your own voice.",
  "prefs.language": "Spoken language",
  "prefs.language.auto": "Detect automatically",
  "prefs.uiLanguage": "Extension language",
  "prefs.uiLanguage.auto": "Same as Chrome",
  "prefs.neverOfferOn": "Never offer on: {sites}",
  "prefs.clearNever": "Clear",
  "prefs.saved": "Saved.",

  // options: on-device transcription
  "ondevice.heading": "On-device transcription",
  "ondevice.toggle": "Transcribe on this computer (audio never leaves the device)",
  "ondevice.unavailable": "Experimental — not available yet in this version.",
  "ondevice.explain":
    "When available, a speech-recognition model will be downloaded once from a third-party host after you agree, and only text will be sent to your server.",

  // options: shortcut
  "shortcut.heading": "Keyboard shortcut",
  "shortcut.current": "Start/stop recording the current tab: {shortcut}",
  "shortcut.none": "not set",
  "shortcut.change": "Change it at chrome://extensions/shortcuts.",
} as const;

export type MessageKey = keyof typeof en;
