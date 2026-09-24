# Bir sorun mu yaşıyorsunuz? Steam tartışmasına yazın

> Bu metin, Steam Atölyesi'ndeki [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) tartışmasının çevirisidir. Soru sormak veya bir sorun bildirmek için o tartışmaya yorum bırakın — İngilizce yazmanız gerekmez, Türkçe yazabilirsiniz.

Ters giden her şeyin yeri [Steam tartışması](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/): çökmeler, katılmayı bir türlü tamamlayamayan bir oyuncu, yanlış görüntülenen bir şey, bozulan bir koşu.

**Telefonunuz veya tabletiniz katılma sayfasına hiç ulaşamıyorsa**, önce [Telefon veya tabletten bağlanamıyor musunuz?](phone-connection-troubleshooting.md) sayfasını okuyun — Wi-Fi, güvenlik duvarları ve yönlendiriciler orada ayrıntılı olarak ele alınıyor ve çoğu bağlantı sorunu orada çözülüyor.

---

## Rapora neler eklenmeli

Her şeyi yanıtlamanız gerekmez — ilk ikisi, geri kalanların toplamından daha değerlidir.

### 1. Ne oldu ve bunun yerine ne bekliyordunuz

Bir iki cümle yeterli. Ekranda bir hata mesajı varsa, altındaki daha küçük gri satır dahil olmak üzere mesajı aynen aktarın. Bir fotoğraf veya ekran görüntüsü mükemmel olur.

### 2. Sorun katılmayla veya lobiyle ilgiliyse: bağlantı raporu

*Sorununuz daha sonra — bir koşu sırasında veya oyunun kendisinde — ortaya çıkıyorsa doğrudan 3. adıma geçin.*

Lobiden **Kanepede İşbirliği QR Kodu** ekranını açın. **Bağlantılar** paneli bu ekranda, kodun altındadır. Ters giden her şey **Bağlantı sorunları** altında tutulur (yanında bir sayıyla).

Başarısız olan satırı seçin ve **Raporu kopyala** düğmesine basın, ardından raporu yorumunuza yapıştırın. Katılma sorunlarında ekleyebileceğiniz en faydalı şey budur: başarısız olan adımı, süreleri, host bilgisayarın kendi teşhisini ve aşağıda anlatılan log dosyalarının yollarını zaten içerir.

### 3. Log dosyaları

İki türü vardır ve hangisinin önemli olduğu soruna bağlıdır.

**Ana oyun logu**, host bilgisayarda:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Oyuncu başına log.** Katılan her oyuncu için host bilgisayarda arka planda oyunun ayrı bir kopyası çalışır ve her kopya kendi log dosyasını tutar. **Bir oyuncu katılırken takılıp kaldıysa, nedenini açıklayan dosya budur** — yukarıdaki ana log genellikle bunu açıklamaz.

Oyuncular 2'den başlayarak numaralandırılır, bu yüzden size ilk katılan kişi `slot-2` olur. Linux'ta bu oyuncunun log dosyası şuradadır:

`~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`

(Evet, `SlayTheSpire2` gerçekten iki kez geçiyor — bu bir yazım hatası değil.) Windows ve macOS'ta da yapı aynıdır, yukarıdaki listede yer alan klasörün altında. Bazı kurulumlarda bunun yerine `couch-coop/seat-logs/slot-2.log` konumunda tek bir dosyadır. Her iki durumda da **2. adımdaki rapor tam yolu belirtir**, bu yüzden önce onu kopyalarsanız aramakla uğraşmazsınız.

**Hangi satırlar önemli.** Her iki dosyada da işe yarayanlar `[couchcoop]` içeren satırlardır — `[INFO] [couchcoop] ...` gibi görünürler — ve bunlara ek olarak, couchcoop'tan hiç bahsetmeyenler dahil tüm `[ERROR]` satırları. Genellikle tek başlarına bu satırlar yeterlidir.

**Bir log dosyasının tamamını yapıştırmadan önce:** Steam tartışması herkese açıktır ve bir log dosyası, dosya yollarında kendi **SteamID64** numaranızı (7656 ile başlayan ve Steam profilinize işaret eden uzun bir sayı) ve bilgisayarınızın **kullanıcı adını** içerir. Parola *içermez*, diğer oyuncuların hesaplarını da içermez — yalnızca sizinkini. Bunları paylaşmak istemiyorsanız yapıştırmadan önce bu ikisini bul-değiştir ile değiştirmeniz yeterlidir; ya da sadece `[couchcoop]` ve `[ERROR]` satırlarını paylaşın, daha fazlasına ihtiyacım olursa sorarım.

### 4. Sürümler ve modlar

- Oyunun **kararlı** dalında mı yoksa **herkese açık beta** dalında mı olduğunuz.
- **Başka hangi modların kurulu olduğu.** Arka plandaki her oyuncu kopyası host ile aynı modları yükler; bu yüzden host bilgisayardaki oyun kusursuz görünse bile başka bir mod, bir oyuncunun katılmayı tamamlamasını engelleyebilir.
- Host bilgisayarın işletim sistemi.
- Biliyorsanız CouchCoop sürümü — bilmiyorsanız en yenisi olduğunu varsayarım.

### 5. Sorunu daraltan her şey

- Her seferinde mi oluyor, yoksa sadece bazen mi?
- Her oyuncuda mı oluyor, yoksa sadece birinde mi?
- Daha önce hiç çalıştı mı ve o zamandan beri bir şey değişti mi — bir oyun güncellemesi, yeni bir mod?

---

## Bildirmeden önce bilmeye değer bir şey

Bir oyuncunun oyununu başlatmak bir dakikayı bulabilir ve daha yavaş bir bilgisayarda bu sürenin çoğu kullanılır. Bu normaldir, bir arıza değildir. Bu sırada katılma sayfası *Katılıyor…* yazısının altında süreyi sayar ve aşama değiştirir — o satır hâlâ ilerliyorsa henüz hiçbir şey ters gitmemiştir, bu yüzden sayfayı açık tutun.
