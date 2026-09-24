# Telefon veya tabletten bağlanamıyor musun?

> Bu metin, Steam Atölyesi'ndeki [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) tartışmasının çevirisidir. Soru sormak veya bir sorun bildirmek için o tartışmaya yorum bırak — İngilizce yazman gerekmez, Türkçe yazabilirsin.

Bağlantı sorunlarının çoğu birkaç nedenden birine dayanır. Bu liste kabaca en yaygından en az yaygına doğru sıralanmıştır, bu yüzden sırayla ilerlemeye değer.

*Telefonun katılma sayfasını sorunsuz açıyor ama sorun başka bir şeyse — bir çökme, katılmayı bir türlü tamamlayamayan bir oyuncu, oyunun kendisinde ters giden bir şey — bunun yerine [Bir sorun mu yaşıyorsun? Steam tartışmasına yaz](reporting-a-problem.md) sayfasına bak.*

---

## Denenecekler

### 1. QR ekranında farklı bir adres seç

QR ekranında, host bilgisayara ulaşmanın birkaç yolunu sunan bir seçici var. Taradığın adres çalışmıyorsa başka birini seçip yeniden tara.

Mümkünse düz sayısal adresi tercih et (**192.168.1.5:13337** gibi bir şey). En az bileşene dayanan seçenek budur. **.local** adı ve web bağlantısı, modun dışındaki şeylere bağlıdır — yönlendiricin, internet bağlantısı, tarayıcı izinleri — bu yüzden sayısal adresin sorunsuz çalıştığı bir ağda bile başarısız olabilirler.

**iPhone veya iPad'de *Web bağlantısı* satırını hiç kullanma.** Safari — ve iOS'taki diğer tüm tarayıcılar, çünkü hepsinin altında aslında Safari vardır — internetten yüklenen bir sayfanın ev ağındaki hiçbir şeye ulaşmasına izin vermez. Bu bir ayar değil, tarayıcının kuralıdır; yani izin verilecek ya da değiştirilecek bir şey yoktur: sayfa yüklenir ve ardından, hangi ağda olursan ol ve güvenlik duvarın nasıl ayarlanmış olursa olsun, oyunun yanıt vermediğini söyler. iPhone veya iPad'de **Düz adres** ya da **Güvenli bağlantı** satırını kullan. (O noktaya kadar gelirsen sayfa artık bunu kendisi de söylüyor.)

### 2. Telefonun gerçekten aynı ağda olduğundan emin ol

- Host bilgisayarla aynı Wi-Fi ağında olmalı ve **Misafir** ağında olmamalı. Misafir ağları genellikle cihazların birbiriyle konuşmasını engeller; oysa burada tam olarak buna ihtiyaç var.
- Mobil veride olmamalı. Wi-Fi'ın internet erişimi yoksa telefonlar bazen sana haber vermeden kendiliğinden mobil veriye geçer.
- **Telefondaki tüm VPN'leri kapat.** Pek çok kişi buna takılıyor. VPN olarak çalışan reklam engelleyiciler ve “Gizli DNS” uygulamaları da buna dahildir.

### 3. Katılırken sayfanın sana söylediklerini oku

Bir oyuncunun oyununu başlatmak bir dakikayı bulabilir; bu bir arıza değil, normal bir durumdur. Bu sırada sayfa artık, *Katılıyor…* yazısının altındaki bir satırda nereye kadar geldiğini gösteriyor:

*Oda sahibine ulaşılıyor — adım 1/6, şu ana kadar 14 sn. Bu bir dakikayı bulabilir, lütfen bu sayfayı açık bırak.*

Bu satırdaki süre artıyor ve aşama değişiyorsa işlem devam ediyordur — sayfayı açık tut. Altı aşama şunlardır: oda sahibine ulaşılıyor, oda sahibi bekleniyor, bu oyuncunun oyunu başlatılıyor, bu oyuncu oyuna bağlanıyor, oyun görünümü yükleniyor, neredeyse hazır.

### 4. Durursa, sayfa artık NEDENİNİ söylüyor

Bir şey gerçekten ters gittiğinde, cihazına birbiriyle ilgisiz birkaç sorundan hangisinin yaşandığı söylenir — iki cümle ve gri bir teknik satırla. **Lütfen her raporda bunların hepsini ekle.** Karşılaşabileceğin üç mesaj var ve her biri tamamen farklı bir çözüm gerektirir:

- **“Oyunun, oda sahibinin bilgisayarında çalışıyor ama bu cihaz ona ulaşamadı.”**\
  Sorun, telefonunla host bilgisayar arasındaki ağ yolundadır — misafir Wi-Fi, bir VPN ya da cihazları birbirinden ayıran bir yönlendirici. Host bilgisayardaki oyunda bir sorun yok. 2. ve 6. bölümlere bak.
- **“Oda sahibinin bilgisayarındaki başka bir program, oyununun ihtiyaç duyduğu bağlantı noktasını kullanıyor.”**\
  Cihazında değiştirilecek bir şey yok. Host bilgisayarda başka bir şey, oyuncuların ihtiyaç duyduğu portlardan birini tutuyor — çoğunlukla önceki bir oturumdan kalmış bir oyuncu işlemi. Oyunu barındıran kişi bunu kapatmalıdır (Slay the Spire 2'yi yeniden başlatmak sorunu giderir).
- **“Oda sahibinin bilgisayarı, oyununun sunulduğu bağlantı noktasını engelliyor.”**\
  Burada da cihazında değiştirilecek bir şey yok. Portu engelleyen, host bilgisayarın kendi güvenlik duvarı veya güvenlik yazılımıdır — 5. bölüme bak.

**En yaygın engelleme durumunda *Katılıyor…* hiç görünmez.** Cihazın host bilgisayara ulaştıysa ama kendi oyuncuna verilen porta ulaşamıyorsa, katılma *başarılı olur* — ardından sayfa *Yükleniyor…* ekranına geçer ve orada kalır. Bu ekranda ne ilerleme satırı ne de geri sayım vardır, çünkü host tarafında hiçbir şey başarısız olmamıştır. Göreceğin ilk işe yarar şey, sayfa değiştikten yaklaşık **20 saniye** sonra çıkan, yukarıdaki **“bu cihaz ona ulaşamadı”** mesajıdır. Yani *Yükleniyor…* ekranında takıldıysan, sayfayı yenilemek yerine bu mesaj için yarım dakika bekle — yenilemek tüm bekleme süresini baştan başlatır.

Sayfa bunun yerine *Katılıyor…* ekranında kalıp hiç değişmiyorsa, host 75 saniyede pes eder ve *Oyun görünümün başlatılamadı — lütfen tekrar dene.* mesajını, altında gri bir satırla gösterir. Bu, yukarıdakinden farklı bir hatadır. Her iki durumda da ekranda yazanları kopyala.

### 5. Her oyuncu kendi portunu kullanır

Lobi **13337** numaralı porttadır, ardından her oyuncu **13357**, **13367**, **13377** ve devamındaki portları kullanır. Yalnızca 13337'yi açan bir güvenlik duvarı kuralı oyuncu listesine ulaşmanı sağlar, ancak ikinci adımda başarısız olur. Sen (ya da izlediğin bir rehber) böyle bir kural eklediysen, onu kaldır ve bunun yerine **oyun programının kendisine** izin ver — bu, oyunun ihtiyaç duyduğu tüm portları kapsar.

### 6. Windows: oyunun güvenlik duvarından geçmesine izin ver

Önce ağ türünü kontrol et, çünkü tek başına bu bile pek çok bağlantıyı engeller:

- **Ayarlar > Ağ ve İnternet > Wi-Fi** (veya Ethernet) > ağına tıkla > **Ağ profili türü** ayarını **Özel ağ** yap.

Ardından oyuna izin ver:

- **Ayarlar > Gizlilik ve güvenlik > Windows Güvenliği > Güvenlik duvarı ve ağ koruması > Bir uygulamaya güvenlik duvarı üzerinden izin ver**
- Listede **Slay the Spire 2** oyununu bul ve **Özel** kutusunun işaretli olduğundan emin ol. Listede yoksa **Başka bir uygulamaya izin ver...** seçeneğini kullan ve oyunun `.exe` dosyasını seç.

Bir noktada Windows güvenlik duvarı uyarısında “İptal” düğmesine bastıysan, Windows bunu bir engelleme kuralı olarak hatırlar ve bir daha asla sormaz. Bu durumda yukarıdaki girişi kaldırıp yeniden eklemen gerekir.

**Adresi host bilgisayarın kendisindeki bir tarayıcıda açmak hiçbir şeyi kanıtlamaz.** Akla ilk gelen deneme budur ve ölçümler bunun yanıltıcı olduğunu gösteriyor: Windows, bir bilgisayarın kendisine giden trafiğini — kendi ağ adresine giden trafiği bile — filtrelemez; bu yüzden güvenlik duvarı tüm telefonları etkin biçimde engellerken bile host bilgisayarın kendi tarayıcısı sayfayı kusursuzca yükler. Bu sende çalıştıysa, oyunun çalıştığını ve sayfayı sunduğunu gösterir. Güvenlik duvarı hakkında ise hiçbir şey söylemez.

**Ortak** kutusunu yalnızca ağın Ortak ağ olarak ayarlıysa ve bunu değiştiremiyorsan işaretle. Bu kutuyu işaretlemek, oyunu kafeler ve oteller dahil bağlandığın her ağda erişilebilir kılar.

### 7. Yönlendirici

Bazı yönlendiriciler aynı Wi-Fi'daki cihazların birbirine ulaşmasını engeller. **AP isolation**, **Client isolation** veya **Wireless isolation** adlı bir ayar ara (Türkçe arayüzlerde “AP İzolasyonu” olarak da geçebilir) ve kapat.

Şunu da bilmekte fayda var: **bridge** (köprü) / **access point** (erişim noktası) modu yerine **router** (yönlendirici) modunda kurulmuş bir Wi-Fi genişletici veya powerline adaptörü, Wi-Fi adı aynı görünse bile telefonunu host bilgisayardan ayrı bir ağa koyar.

### 8. Düz adresleri engelleyen tarayıcı ayarları

Bazı tarayıcılar her adresi HTTPS'ye zorlamaya çalışır; düz sayısal adres ise HTTPS kullanmaz. (QR ekranında HTTPS kullanan satır **Güvenli bağlantı** satırıdır — yani sorun HTTPS zorlamasıysa bu satırı da denemeye değer.) Adres çubuğunda oyun yerine bir güvenlik uyarısı görünüyorsa şunları kapatıp yeniden dene:

- Chrome: **Ayarlar > Gizlilik ve güvenlik > Güvenlik > Her zaman güvenli bağlantılar kullan**
- Firefox: **Ayarlar > Gizlilik ve güvenlik > Bağlantı ve yazılım güvenliği > Gelişmiş ayarlar > Yalnızca HTTPS modu**

iPhone'da ayrıca **Ayarlar > *adınız* > iCloud > Özel Geçiş** bölümünü ve **Ayarlar > Uygulamalar > Safari** bölümündeki “IP Adresini Gizle” ayarını kontrol et.

### 9. Kendi güvenlik duvarı olan antivirüsler

ESET, Bitdefender, Norton, Kaspersky ve Avast gibi güvenlik paketlerinin Windows'unkinden ayrı, kendi güvenlik duvarı vardır. Oyuna Windows'ta izin vermek bunları hiç etkilemez. Paketin kendi ağ veya güvenlik duvarı ayarlarını kontrol et ya da engelleyenin bu olup olmadığını görmek için güvenlik duvarını kısa bir süreliğine duraklat.

### 10. Önceden çalışıyorduysa ve sonra durduysa

Host bilgisayarın adresi, Wi-Fi'a yeniden bağlandığında veya yönlendirici yeniden başlatıldıktan sonra değişebilir. QR ekranını yeniden aç ve tekrar tara — yeni adres orada olacaktır.

İstemciyi ana ekranına eklediysen, bundan sonra ne olacağı onu hangi satırdan yüklediğine bağlıdır:

- **Web bağlantısı** satırından yüklendiyse: çalışmaya devam eder ve yeni adresi kendisi bulur. Sadece aç — yeniden taramaya gerek yok.
- **Sayısal adresten** veya **Güvenli bağlantı** satırından yüklendiyse: simge eski adresi gösterir ve kendini düzeltemez. Simgeyi sil ve yeniden taradıktan sonra tekrar ekle. (Android'de bunun yerine **Web bağlantısı** satırından yüklemek bu sorunu kalıcı olarak önler. iPhone veya iPad'de bu satır çalışamaz — 1. bölüme bak — bu yüzden orada tek yol simgeyi yeniden eklemektir.)

---

## Hâlâ takıldın mı? Steam tartışmasına yorum yaz

[Steam tartışmasına](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) bir yorum bırak — her şeyi yanıtlaman gerekmez. Aşağıdakilerden bir ya da ikisi bile bir raporla ilgilenmeyi çok daha kolay hale getirir ve ilk soru, diğer hepsinin toplamından daha değerlidir.

### İş nereye kadar ilerliyor?

Bana söyleyebileceğin en faydalı şey budur, çünkü her yanıt farklı bir nedene işaret eder:

- tarayıcı hiçbir şey yüklemiyor
- sayfa yükleniyor ama oyuncu listesi hiç görünmüyor
- bir isim seçebiliyorsun ama “Katılıyor…” ekranında kalıyor — altındaki ilerleme satırında ne yazdığını ve beklediysen hangi mesajı aldığını bana söyle
- bu aşamayı geçiyor ama bu kez **“Yükleniyor…”** ekranında kalıyor — bu port/güvenlik duvarı durumudur ve en yaygın olanıdır. Yaklaşık 20 saniye sonra “bu cihaz ona ulaşamadı” mesajının çıkıp çıkmadığını bana söyle
- sorunsuz bağlandı, sonra koşu sırasında bağlantı koptu

### Ekleyebileceğin diğer her şey

- Telefonun gösterdiği mesajın tam metni, altındaki gri satır dahil. Ekranın bir fotoğrafı mükemmel olur.
- Hangi adresi taradığın — sayısal adresi mi, **.local** adını mı, yoksa web bağlantısını mı.
- Host bilgisayarın işletim sistemi, ayrıca telefon/tablet modeli ve tarayıcı.
- **Her** cihazda mı başarısız oluyor, yoksa yalnızca birinde mi? Bir telefon çalışıp diğeri çalışmıyorsa bu pek çok olasılığı eler.
- Daha önce hiç çalıştı mı ve o zamandan beri bir şey değişti mi?
- Host bilgisayar Wi-Fi'da mı yoksa Ethernet'te mi. Host bilgisayarda veya telefonda çalışan bir VPN var mı. Güvenlik duvarı olan bir antivirüs var mı.

### Host bilgisayardan alabileceğin üç şey

- **Bağlantı paneli.** Host bilgisayarda **Couch Co-Op QR Kodu** ekranını aç — **Bağlantılar** paneli bu ekranda, kodun altındadır. Orada görünecek kadar ilerleyen cihazlar listelenir ve ters giden her şey **Bağlantı sorunları** altında tutulur (yanında bir sayıyla). Satırı seç ve **Raporu kopyala** düğmesini kullan — bu, başarısız olan adımı, süreleri ve host bilgisayarın kendi teşhisini zaten içeren bir rapor kopyalar. Raporu doğrudan yorumuna yapıştır. Rapor ayrıca aşağıdaki iki log dosyasının tam yolunu da belirtir, böylece onları aramak zorunda kalmazsın.
- **Ana log dosyası.** Windows'ta `%APPDATA%\SlayTheSpire2\logs\godot.log`. Linux'ta `~/.local/share/SlayTheSpire2/logs/godot.log`. macOS'ta `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **Oyuncu başına log.** Katılan her oyuncu için host bilgisayarda arka planda oyunun ayrı bir kopyası çalışır ve her kopya kendi log dosyasını tutar. **Katılma *Katılıyor…* aşamasına ulaşıp ardından zaman aşımına uğradıysa, nedenini açıklayan dosya budur** — yukarıdaki ana log genellikle bunu açıklamaz. Oyuncular 2'den başlayarak numaralandırılır, bu yüzden ilk katılan kişi `slot-2` olur: Linux'ta bu `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` dosyasıdır (evet, iki kez `SlayTheSpire2` — yazım hatası değil); Windows ve macOS yolları da yukarıdaki klasörlerin altında aynı yapıyı izler. Bazı kurulumlarda bunun yerine `couch-coop/seat-logs/slot-2.log` konumunda tek bir dosyadır.

**Hangi satırlar önemli.** Her iki log dosyasında da işe yarayanlar `[couchcoop]` içeren satırlardır — `[INFO] [couchcoop] ...` gibi görünürler — ve bunlara ek olarak, couchcoop'tan hiç bahsetmeyenler dahil tüm `[ERROR]` satırları. Genellikle tek başlarına bunlar yeterlidir.

**Bir log dosyasının tamamını yapıştırmadan önce:** Steam tartışması herkese açıktır ve bir log dosyası, dosya yollarında kendi **SteamID64** numaranı (7656 ile başlayan ve Steam profiline işaret eden uzun bir sayı) ve bilgisayarının **kullanıcı adını** içerir. Parola *içermez*, diğer oyuncuların hesaplarını da içermez — yalnızca seninkini. Bunları paylaşmak istemiyorsan yapıştırmadan önce bu ikisini bul-değiştir ile değiştirmen yeterlidir; ya da sadece `[couchcoop]` ve `[ERROR]` satırlarını paylaş, daha fazlasına ihtiyacım olursa sorarım.

---

Son bir not: katılma adresine ulaşabilen herkes istemciyi açıp oynayabilir, bu yüzden bunu güvendiğin bir ağda kullan.
