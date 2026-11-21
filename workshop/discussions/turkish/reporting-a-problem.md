# Bir sorun mu yaşıyorsun? Steam tartışmasına yaz

> Bu metin, Steam Atölyesi'ndeki [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) tartışmasının çevirisidir. Soru sormak veya bir sorun bildirmek için o tartışmaya yorum bırak — İngilizce yazman gerekmez, Türkçe yazabilirsin.

Bir şey ters giderse [Steam tartışmasına](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) yaz: oyun çökerse, bir oyuncu katılmayı tamamlayamazsa, bir şey yanlış görüntülenirse veya koşu bozulursa.

**Telefonun veya tabletin katılma sayfasını hiç açamıyorsa**, önce [Telefon veya tabletten bağlanamıyor musun?](phone-connection-troubleshooting.md) sayfasını oku. Çoğu bağlantı sorunu, orada anlatılan bir Wi-Fi, güvenlik duvarı veya yönlendirici ayarından kaynaklanır.

### Katılma sırasında takılmayı bildirmeden önce

Bir oyuncunun oyununu başlatmak, özellikle yavaş bir bilgisayarda, bir dakikayı bulabilir. Katılma sayfasında **Katılıyor…** yazısının altındaki satırda süre artmaya ve satır değişmeye devam ediyorsa işlem hâlâ sürüyordur; sayfayı açık tut.

---

## Rapora neler eklenmeli

Her şeyi yanıtlaman gerekmez. En çok ilk iki madde yardımcı olur.

### 1. Ne oldu ve ne bekliyordun

Bir iki cümle yeterli. Bir hata çıktıysa altındaki küçük gri satır da dahil mesajı aynen kopyala ya da ekran görüntüsü veya ekranın fotoğrafını paylaş.

### 2. Bağlantı raporu (katılma veya lobi sorunları)

*Sorun koşu sırasında olduysa bu adımı atla.*

Bilgisayarda **Couch Co-Op QR Kodu** ekranını aç, ardından **Bağlantılar** bölümüne bak. **Bağlantı sorunları** altındaki başarısız bağlantıyı seç, **Raporu kopyala** seçeneğini seç ve raporu yorumuna yapıştır.

Rapor, hangi adımın başarısız olduğunu, her adımın ne kadar sürdüğünü ve host bilgisayarın sorunun nedenine dair teşhisini içerir. Aşağıdaki log dosyalarının yollarını da listeler.

### 3. Log dosyaları

Bağlantı raporunu kopyaladıysan tam yollar zaten orada listelenir.

**Oyun logu**, host bilgisayarda:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Oyuncu logları.** Katılan her oyuncu için host bilgisayarda oyunun ayrı, gizli bir kopyası çalışır ve kendi logunu tutar. Bir oyuncu katılırken takılıp kaldıysa oyuncunun logu genellikle nedenini açıklar; oyun logu genellikle açıklamaz.

İlk katılan oyuncu slot-2, sonraki slot-3 olur ve böyle devam eder. slot-2 için:

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

`headless-slots` klasörü yoksa log dosyası, oyun logunun bulunduğu `SlayTheSpire2` klasörünün içinde `couch-coop/seat-logs/slot-2.log` konumundadır.

**Hangi satırlar önemli.** Her iki logda da en çok ihtiyacım olan satırlar, `[couchcoop]` içerenlerdir (örneğin `[INFO] [couchcoop] ...`). Ayrıca couchcoop'tan bahsetmeyenler dahil tüm `[ERROR]` satırları da önemlidir. Genellikle bunlar yeterlidir.

**Bir log dosyasının tamamını yapıştırmadan önce:** Bu tartışma herkese açıktır. Log, SteamID64 numaranı (7656 ile başlayan ve Steam profiline bağlanan uzun bir sayı) ve dosya yollarında bilgisayarının kullanıcı adını içerir. Parolaları veya diğer oyuncuların hesaplarını içermez. Bu iki bilgiyi paylaşmak istemiyorsan yapıştırmadan önce değiştir ya da yalnızca `[couchcoop]` ve `[ERROR]` satırlarını paylaş; daha fazlasına ihtiyacım olursa sorarım.

### 4. Sürümler ve modlar

- Oyunun **kararlı** dalında mı yoksa **herkese açık beta** dalında mı olduğun.
- **Kurduğun diğer modlar.** Her oyuncunun oyun kopyası host ile aynı modları yükler. Bu yüzden host bilgisayardaki oyun düzgün çalışsa bile başka bir mod oyuncunun katılmasını engelleyebilir.
- Host bilgisayarın işletim sistemi.
- Biliyorsan CouchCoop sürümün. Bilmiyorsan en yenisi olduğunu varsayarım.

### 5. Sorunu daraltmaya yardımcı olan bilgiler

- Her seferinde mi oluyor, yoksa sadece bazen mi?
- Her oyuncuda mı oluyor, yoksa sadece birinde mi?
- Daha önce çalışıyor muydu? O zamandan beri oyun güncellemesi veya yeni bir mod gibi bir şey değişti mi?
