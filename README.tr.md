# LTM — konuşmalarınız için uzun süreli bellek

[English](README.md) · **Türkçe**

LTM, seçtiğiniz cihazlar üzerinden dinler — toplantılarda tarayıcınız, telefonunuz,
saatiniz — konuşmayı metne çevirir, birden fazla cihazın duyduğunu tek bir dökümde
birleştirir ve bir dil modeline notları, yapılacakları ve aksi halde kaybolacak kalıcı
anıları yazdırır. Kendi sunucunuzda çalışır; konuşmalarınız sizin makinenizde kalır.

> **LTM insanları kaydeder.** Birçok ülkede bir konuşmayı içindeki herkesin bilgisi veya
> rızası olmadan kaydetmek hukuka aykırıdır (Türkiye'de TCK md. 132–136 ve KVKK). LTM, bu
> sorumluluğu kabul etmeden hiçbir şey kaydetmez, dinlerken bunu her zaman gösterir ve
> karşınızdakileri bilgilendirmeniz için hazır metinler sunar. Kullanmadan önce
> [`docs/legal/CONSENT.md`](docs/legal/CONSENT.md) belgesini okuyun.

## Zincirde neler var

| Uygulama | Konum | Ne yapar |
| --- | --- | --- |
| **Sunucu** | [`apps/server`](apps/server) | Sesi ve dökümleri alır, konuşmayı metne çevirir, cihazları birleştirir, LLM ile notları ve günlük özetleri yazar, belleğinizi saklar ve arar. Tek süreç; varsayılan olarak gömülü veritabanı. |
| **Web uygulaması** | [`apps/web`](apps/web) | Bugünün özeti, zaman akışı, notlar ve dökümler, anılar, arama ve "sor", cihaz eşleştirme, sağlayıcı ve gizlilik ayarları. Telefona uygulama gibi kurulabilir; herhangi bir tarayıcı mikrofon olarak kullanılabilir. |
| **Chrome eklentisi** | [`apps/extension`](apps/extension) | Toplantı sekmesinin (Meet, Zoom, Teams…) sesini ve mikrofonunuzu yakalar. |
| **Yakalama ajanı** | [`apps/agent`](apps/agent) | Linux, macOS veya Windows'ta bir mikrofonu gün boyu dinleyen küçük bir arka plan servisi. |
| **iPhone uygulaması** | [`apps/apple`](apps/apple) | Masa başında olmadığınızda kaydeder (isteğe bağlı cihaz üzerinde yazıya dökme) ve tam bir okuyucudur: günler, görüşmeler, anılar, soru sorma. |
| **Apple Watch uygulaması** | [`apps/apple`](apps/apple) | Bileğinizden kaydeder; doğrudan veya telefon üzerinden eşitler. |

Ortak kod: [`packages/protocol`](packages/protocol) (iletişim sözleşmesi),
[`packages/core`](packages/core) (çok cihazlı birleştirme, VAD),
[`packages/capture`](packages/capture) (JavaScript istemcilerinin ses hattı) ve
[`packages/providers`](packages/providers) (model bağdaştırıcıları).

## Nasıl çalışır

```
cihazlar ──ses / cihaz üzerinde döküm──► sunucu
   konuşma tanıma ─► cihaz başına bölütler ─► çok cihazlı birleştirme ─► tek döküm
   ─► görüşme sınırları ─► LLM: notlar · yapılacaklar · kararlar · anılar
   ─► gömmeler (embedding) ─► arama ve soru-cevap
```

- **Birden fazla cihaz, tek döküm.** Dizüstünüz ve saatiniz aynı cümleyi duyduğunda LTM,
  farklı kesim noktalarına, farklı tanıma sonuçlarına ve saat farklarına rağmen bunun
  aynı konuşma olduğunu anlar, en iyi sürümü tutar ve yalnızca tek cihazın duyduğunu asla
  atmaz. Geç eşitlenen cihazlar dökümü sonradan iyileştirir.
- **Gün boyu, siz yaşarken özet.** Açık bırakın: konuşmalar sessizliklerde kendiliğinden
  ayrılır, bir konuşma sürerken notları birkaç dakikada bir yeniden yazılır ve her günün
  kararları ve açık işleriyle birlikte bir özeti çıkar.
- **Yalnızca tutanak değil, bellek.** Görüşme notlarının ötesinde LTM; kendi başına
  anlamlı olguları, tercihleri, verilen sözleri ve kararları, web uygulamasından ya da
  telefonunuzdan arayıp sorgulayabileceğiniz uzun süreli bir belleğe çıkarır.
- **Modeller sizin.** Tamamen yerel modeller, kendi API anahtarınız (BYOK) veya resmî
  komut satırı aracı üzerinden Claude / ChatGPT aboneliğiniz — her rol için ayrı ayrı.
  Bkz. [`docs/PROVIDERS.md`](docs/PROVIDERS.md).
- **Varsayılan olarak gizli.** Telemetri yok. Ses, yazıya döküldükten sonra silinir.
  İsteğe bağlı cihaz üzerinde yazıya dökme, sesi ağa hiç çıkarmaz. Her şeyi istediğiniz an
  dışa aktarabilir veya silebilirsiniz. Bkz. [`PRIVACY.md`](PRIVACY.md).

Tasarım [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) belgesinde anlatılır.

## Hızlı başlangıç

Gereksinimler: Node.js 22+ ve pnpm 10+.

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm --filter @ltm/server start
```

`http://localhost:8080` adresini açın, sahip hesabını oluşturun, rıza metinlerini
onaylayın, **Ayarlar → Yapay zekâ sağlayıcıları** altında sağlayıcıları yapılandırın ve
**Cihazlar** altında ilk cihazınızı eşleştirin. Docker, HTTPS, PostgreSQL ve tamamen
yerel model kurulumu için [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) belgesine bakın.

Geliştirme (`pnpm dev`, testler, eklentiyi yükleme, Apple uygulamalarını derleme) için
[`CONTRIBUTING.md`](CONTRIBUTING.md) ve her uygulamanın kendi README dosyasına bakın.

## Durum

Erken aşama, ama zincirin tamamı gerçekten çalıştırıldı:

- **Sunucu, web uygulaması, eklenti, yakalama ajanı** — CI'da birim ve entegrasyon
  testleri; ayrıca uçtan uca çalıştırmalar: derlenmiş eklenti Chromium'da derlenmiş
  sunucuya karşı, gerçek konuşma gönderen ajan ve eksiksiz Docker Compose yığını (LTM,
  pgvector'lü PostgreSQL, Speaches ile Whisper, Ollama ile yerel model): iki cihazdan
  gelen Türkçe konuşma tek döküme, notlara, günlük özete, aramaya ve yanıtlara dönüştü.
- **iPhone ve saat uygulamaları** — CI'da macOS üzerinde derlendi ve birim testlerinden
  geçti (imzasız simülatör derlemeleri). Fiziksel cihazda henüz çalıştırılmadı: arka plan
  ses kaydı, saat kaydı ve telefon–saat aktarımı bunu gerektirir. Bkz.
  [`apps/apple/README.md`](apps/apple/README.md).
- Henüz yok: konuşmacı ayrıştırma, uçtan uca şifreleme, Android, tarayıcıda cihaz
  üzerinde yazıya dökme.

## Lisans

LTM **kaynağı görülebilir** bir yazılımdır, açık kaynak değildir: kişisel ve diğer ticari
olmayan kullanım için [PolyForm Noncommercial License 1.0.0](LICENSE) kapsamında
ücretsizdir; **ticari kullanım ticari lisans gerektirir** (barındırılan hizmetin
Enterprise planı). Bunun pratikte ne anlama geldiği [`LICENSING.md`](LICENSING.md)
dosyasında açıklanır.

Katkılar [Katkıcı Lisans Sözleşmesi](CLA.md) kapsamında memnuniyetle karşılanır —
[`CONTRIBUTING.md`](CONTRIBUTING.md) ile başlayın. Güvenlik ve gizlilik sorunları:
[`SECURITY.md`](SECURITY.md). Beklenen kullanım:
[`docs/legal/ACCEPTABLE_USE.md`](docs/legal/ACCEPTABLE_USE.md).
