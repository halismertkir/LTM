import type { MessageKey } from "./en.js";

export const tr: Record<MessageKey, string> = {
  // toolbar
  "action.title.idle": "LTM",
  "action.title.recording": "LTM — kayıt yapılıyor",
  "action.title.recordingDegraded": "LTM — kayıt yapılıyor (yeniden bağlanıyor, ses arabellekte)",
  "action.title.consent": "LTM — kayıttan önce onay gerekli",
  "action.title.paused": "LTM — hesabınız için kayıt duraklatıldı",
  "action.title.error": "LTM — hata",
  "action.title.notPaired": "LTM — eşleştirilmedi",
  "action.title.meeting": "LTM — toplantı algılandı: kaydetmek için tıklayın",

  // popup: state headline
  "state.notPaired": "Eşleştirilmedi",
  "state.notPaired.sub": "Önce bu tarayıcıyı LTM sunucunuza bağlayın.",
  "state.consent": "Engellendi: onay gerekli",
  "state.consent.sub": "Herhangi bir şey kaydedilmeden önce onay belgelerini kabul edin.",
  "state.paused": "Duraklatıldı",
  "state.paused.sub": "Kayıt tüm hesabınız için duraklatıldı. Panelden devam ettirebilirsiniz.",
  "state.idle": "Beklemede",
  "state.idle.sub": "Şu anda hiçbir şey kaydedilmiyor.",
  "state.error": "Hata",
  "state.listening.tab": "Bu sekme dinleniyor",
  "state.listening.otherTab": "Bir sekme dinleniyor",
  "state.listening.mic": "Mikrofon dinleniyor",
  "state.listening.tabMic": "Bu sekme + mikrofon dinleniyor",
  "state.listening.otherTabMic": "Bir sekme + mikrofon dinleniyor",
  "state.connecting": "Sunucunuza bağlanılıyor…",
  "state.reconnecting": "Yeniden bağlanıyor — {seconds} sn ses arabellekte",
  "state.stopping": "Durduruluyor…",

  // popup: controls
  "popup.recordTab": "Bu sekmeyi kaydet",
  "popup.stopTab": "Sekmeyi durdur",
  "popup.recordMic": "Mikrofonu kaydet",
  "popup.stopMic": "Mikrofonu durdur",
  "popup.copyNotice": "“Kayıt yapıyorum” bildirimini kopyala",
  "popup.copied": "Kopyalandı — toplantı sohbetine yapıştırın.",
  "popup.copyFailed": "Kopyalanamadı. Aşağıdaki metni seçip elle kopyalayın.",
  "popup.dashboard": "Paneli aç",
  "popup.settings": "Ayarlar",
  "popup.pair": "Bu tarayıcıyı eşleştir",
  "popup.reviewConsent": "Onayı incele",
  "popup.dismiss": "Kapat",
  "popup.captionWaiting": "Konuşma bekleniyor…",
  "popup.captionLabel": "Canlı altyazı",
  "popup.elapsed": "Geçen süre",
  "popup.shortcut": "Kısayol: {shortcut}",
  "popup.micWithTab": "Mikrofonunuz sekme sesiyle birlikte kaydediliyor (ayarlara bakın).",
  "popup.restrictedTab": "Bu sayfa kaydedilemez.",

  // errors
  "error.unauthorized": "Bu tarayıcı LTM hesabınızdan kaldırıldı. Yeniden eşleştirin.",
  "error.consent_required": "Sunucunuz kayıttan önce onay istiyor.",
  "error.ingest_paused": "Hesabınız için kayıt duraklatıldı.",
  "error.unsupported_protocol":
    "LTM sunucunuz farklı bir protokol sürümü kullanıyor. Eklentiyi veya sunucuyu güncelleyin.",
  "error.needs_invocation":
    "Chrome, bir eklentinin sekmeyi kaydetmesine ancak o sekmede araç çubuğundaki simgesine tıkladıktan (veya kısayolunu kullandıktan) sonra izin verir.",
  "error.restricted_tab": "Tarayıcı sayfaları, Web Mağazası ve diğer eklentiler kaydedilemez.",
  "error.mic_denied": "Mikrofon erişimine izin verilmiyor. Ayarlar sayfasından izin verin.",
  "error.capture_failed": "Kayıt başlatılamadı: {detail}",
  "error.server_unreachable": "LTM sunucunuza ulaşılamıyor.",
  "error.stream_error": "Sunucu akışı durdurdu: {detail}",

  // content-script banner
  "banner.question": "Bu toplantı LTM ile kaydedilsin mi?",
  "banner.start": "Başlat",
  "banner.notNow": "Şimdi değil",
  "banner.never": "Bu sitede asla",
  "banner.needsClick":
    "Chrome, bir sekmenin kaydedilebilmesi için araç çubuğundaki LTM simgesine bir kez tıklamanızı (veya {shortcut}) gerektirir.",
  "banner.started": "LTM bu toplantıyı kaydediyor. Diğer katılımcılara haber verin.",
  "banner.close": "Kapat",

  // options: general
  "options.title": "LTM ayarları",
  "options.intro":
    "LTM, tarayıcıdaki toplantıların sesini (isteğe bağlı olarak mikrofonunuzu da) kaydeder ve kendi LTM sunucunuza gönderir; sunucu bunu dökümlere, notlara ve anılara dönüştürür.",

  // options: pairing
  "pair.heading": "Sunucu bağlantısı",
  "pair.serverUrl": "Sunucu adresi",
  "pair.serverUrl.placeholder": "https://ltm.example.org",
  "pair.code": "Eşleştirme kodu",
  "pair.code.placeholder": "K7QF-2MXD (veya ltm://pair bağlantısını yapıştırın)",
  "pair.code.help":
    "Panelde Cihazlar → Cihaz eşleştir bölümünden bir kod oluşturun. Kod 10 dakika geçerlidir.",
  "pair.deviceName": "Bu tarayıcının adı",
  "pair.submit": "Eşleştir",
  "pair.checking": "Sunucu kontrol ediliyor…",
  "pair.pairing": "Eşleştiriliyor…",
  "pair.permissionExplain":
    "Chrome, LTM'nin {origin} ile iletişim kurmasına izin vermenizi isteyecek. Bu sizin sunucunuz; LTM ses göndermek için bu izne ihtiyaç duyar.",
  "pair.permissionDenied": "{origin} erişimi olmadan eklenti sunucunuzla iletişim kuramaz.",
  "pair.insecure":
    "Bu adres yerel olmayan bir sunucuda şifresiz http kullanıyor: cihaz anahtarınız ve kayıtlarınız şifrelenmeden iletilir. Güvenilir bir özel ağ değilse https kullanın.",
  "pair.protocolMismatch":
    "Protokol uyuşmazlığı: sunucu {server} sürümünü, bu eklenti {client} sürümünü kullanıyor. Hangisi eskiyse onu güncelleyin.",
  "pair.notLtm": "Bu adreste yanıt veren bir LTM sunucusu yok.",
  "pair.serverOk": "LTM sunucusu {version} (protokol {protocol}).",
  "pair.badCode":
    "Eşleştirme kodu kabul edilmedi. Kodlar tek kullanımlıktır ve 10 dakika sonra geçersiz olur.",
  "pair.failed": "Eşleştirme başarısız: {detail}",
  "pair.paired": "{server} ile “{device}” adıyla {user} için eşleştirildi.",
  "pair.unpair": "Bu tarayıcının eşleştirmesini kaldır",
  "pair.unpairConfirm":
    "Cihaz anahtarı silinsin mi? Yeniden bağlanmak için yeni bir eşleştirme kodu gerekir.",
  "pair.unpaired": "Eşleştirme kaldırıldı. Anahtar bu tarayıcıdan silindi.",
  "pair.revokeHint": "Anahtarı sunucuda da iptal etmek için bu cihazı panelden kaldırın.",

  // options: consent
  "consent.heading": "Onay",
  "consent.satisfied": "Gerekli tüm belgeler kabul edildi.",
  "consent.required":
    "Herhangi bir kayıt yapılmadan önce sunucunuz bu belgeleri kabul etmenizi istiyor.",
  "consent.checkbox": "“{title}” metnini okudum ve kabul ediyorum.",
  "consent.accept": "Kabul et",
  "consent.accepted": "Teşekkürler — onayınız kaydedildi.",
  "consent.versionMismatch":
    "Sunucu “{title}” belgesinin {server} sürümünü istiyor, ancak bu eklentide {local} sürümü var. Panelden kabul edin veya eklentiyi güncelleyin.",
  "consent.unavailable": "Önce bu tarayıcıyı eşleştirin.",
  "consent.loadFailed": "Onay durumunuz yüklenemedi: {detail}",

  // options: microphone
  "mic.heading": "Mikrofon",
  "mic.explain":
    "Kendi sesinizi kaydetmek için (masa başında ya da kulaklıkla katıldığınız toplantılarda) Chrome'un bu eklentinin mikrofonu kullanmasına izin vermesi gerekir. Mikrofon yalnızca LTM “REC” gösterirken açıktır.",
  "mic.grant": "Mikrofona izin ver",
  "mic.granted": "Mikrofon erişimine izin verildi.",
  "mic.denied":
    "Mikrofon erişimi engellendi. İzin vermek için bu sayfada adres çubuğunun sağındaki simgeye tıklayın (veya bu eklentinin Chrome site ayarlarını açın).",
  "mic.prompt": "Henüz karar verilmedi.",

  // options: preferences
  "prefs.heading": "Tercihler",
  "prefs.autoOffer": "Toplantı sitelerinde kaydı öner (Google Meet, Zoom, Teams)",
  "prefs.autoOffer.help":
    "Görüşme başladığında küçük bir bildirim gösterir. Siz başlatmadan hiçbir şey kaydedilmez.",
  "prefs.micWithTab": "Sekme sesiyle birlikte mikrofonumu da kaydet",
  "prefs.micWithTab.help": "Önerilir: kulaklık kullanırken sekme sesi kendi sesinizi içermez.",
  "prefs.language": "Konuşma dili",
  "prefs.language.auto": "Otomatik algıla",
  "prefs.uiLanguage": "Eklenti dili",
  "prefs.uiLanguage.auto": "Chrome ile aynı",
  "prefs.neverOfferOn": "Şu sitelerde asla önerme: {sites}",
  "prefs.clearNever": "Temizle",
  "prefs.saved": "Kaydedildi.",

  // options: on-device transcription
  "ondevice.heading": "Cihazda yazıya dökme",
  "ondevice.toggle": "Bu bilgisayarda yazıya dök (ses cihazdan hiç çıkmaz)",
  "ondevice.unavailable": "Deneysel — bu sürümde henüz kullanılamıyor.",
  "ondevice.explain":
    "Kullanılabilir olduğunda, onay vermenizin ardından bir konuşma tanıma modeli üçüncü taraf bir sunucudan bir kez indirilecek ve sunucunuza yalnızca metin gönderilecek.",

  // options: shortcut
  "shortcut.heading": "Klavye kısayolu",
  "shortcut.current": "Geçerli sekmenin kaydını başlat/durdur: {shortcut}",
  "shortcut.none": "atanmadı",
  "shortcut.change": "chrome://extensions/shortcuts adresinden değiştirebilirsiniz.",
};
