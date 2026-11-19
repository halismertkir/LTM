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
| **Sunucu** | [`apps/server`](apps/server) | Sesi ve dökümleri alır, konuşmayı metne çevirir, cihazları birleştirir, LLM ile özetler, belleğinizi saklar ve arar. Tek süreç; varsayılan olarak gömülü veritabanı. |
| **Web paneli** | [`apps/web`](apps/web) | Zaman çizelgesi, görüşme notları ve dökümleri, anılar, arama ve "sor", cihaz eşleştirme, sağlayıcı ve gizlilik ayarları. |
| **Chrome eklentisi** | [`apps/extension`](apps/extension) | Toplantı sekmesinin (Meet, Zoom, Teams…) sesini ve mikrofonunuzu yakalar. |
| **iPhone uygulaması** | [`apps/apple`](apps/apple) | Masa başında olmadığınız konuşmaları yakalar; isteğe bağlı cihaz üzerinde yazıya dökme. |
| **Apple Watch uygulaması** | [`apps/apple`](apps/apple) | Bileğinizden kaydeder; doğrudan veya telefon üzerinden eşitler. |

Ortak kod: [`packages/protocol`](packages/protocol) (iletişim sözleşmesi),
[`packages/core`](packages/core) (çok cihazlı birleştirme, VAD) ve
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
- **Yalnızca tutanak değil, bellek.** Görüşme notlarının ötesinde LTM; kendi başına
  anlamlı olguları, tercihleri, verilen sözleri ve kararları arayıp sorgulayabileceğiniz
  uzun süreli bir belleğe çıkarır.
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

Erken aşama. Sunucu, web uygulaması ve eklenti CI'da derlenip test edilir. iOS ve watchOS
uygulamalarının kaynak kodu tamdır ancak bir Mac'te Xcode ile derlenip imzalanmaları
gerekir; nelerin doğrulanıp nelerin doğrulanmadığı
[`apps/apple/README.md`](apps/apple/README.md) dosyasındadır. Konuşmacı ayrıştırma, uçtan
uca şifreleme ve Android/masaüstü istemcileri henüz yoktur.

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
