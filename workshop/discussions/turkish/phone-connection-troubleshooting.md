# Telefon veya tabletten bağlanamıyor musunuz?

> Bu metin, Steam Atölyesi'ndeki [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) tartışmasının çevirisidir. Soru sormak veya bir sorun bildirmek için o tartışmaya yorum bırakın — İngilizce yazmanız gerekmez, Türkçe yazabilirsiniz.

Bağlantı sorunlarının çoğu birkaç nedenden birine dayanır. Bu liste kabaca en yaygından en az yaygına doğru sıralanmıştır, bu yüzden sırayla ilerlemeye değer.

*Telefonunuz katılma sayfasını sorunsuz açıyor ama sorun başka bir şeyse — bir çökme, katılmayı bir türlü tamamlayamayan bir oyuncu, oyunun kendisinde ters giden bir şey — bunun yerine [Bir sorun mu yaşıyorsunuz? Steam tartışmasına yazın](reporting-a-problem.md) sayfasına bakın.*

---

## Denenecekler

### 1. QR ekranında farklı bir adres seçin

QR ekranında, host bilgisayara ulaşmanın birkaç yolunu sunan bir seçici var. Taradığınız adres çalışmıyorsa başka birini seçip yeniden tarayın.

Mümkünse düz sayısal adresi tercih edin (**192.168.1.5:13337** gibi bir şey). En az bileşene dayanan seçenek budur. **.local** adı ve web bağlantısı, modun dışındaki şeylere bağlıdır — yönlendiriciniz, internet bağlantısı, tarayıcı izinleri — bu yüzden sayısal adresin sorunsuz çalıştığı bir ağda bile başarısız olabilirler.

**iPhone veya iPad'de *Web bağlantısı* satırını hiç kullanmayın.** Safari — ve iOS'taki diğer tüm tarayıcılar, çünkü hepsinin altında aslında Safari vardır — internetten yüklenen bir sayfanın ev ağınızdaki hiçbir şeye ulaşmasına izin vermez. Bu bir ayar değil, tarayıcının kuralıdır; yani izin verilecek ya da değiştirilecek bir şey yoktur: sayfa yüklenir ve ardından, hangi ağda olursanız olun ve güvenlik duvarınız nasıl ayarlanmış olursa olsun, oyunun yanıt vermediğini söyler. iPhone veya iPad'de **Açık adres** ya da **Güvenli bağlantı** satırını kullanın. (O noktaya kadar gelirseniz sayfa artık bunu kendisi de söylüyor.)

### 2. Telefonun gerçekten aynı ağda olduğundan emin olun

- Host bilgisayarla aynı Wi-Fi ağında olmalı ve **Misafir** ağında olmamalı. Misafir ağları genellikle cihazların birbiriyle konuşmasını engeller; oysa burada tam olarak buna ihtiyaç var.
- Mobil veride olmamalı. Wi-Fi'ın internet erişimi yoksa telefonlar bazen size haber vermeden kendiliğinden mobil veriye geçer.
- **Telefondaki tüm VPN'leri kapatın.** Pek çok kişi buna takılıyor. VPN olarak çalışan reklam engelleyiciler ve “Gizli DNS” uygulamaları da buna dahildir.

### 3. Katılırken sayfanın size söylediklerini okuyun

Bir oyuncunun oyununu başlatmak bir dakikayı bulabilir; bu bir arıza değil, normal bir durumdur. Bu sırada sayfa artık, *Katılıyor…* yazısının altındaki bir satırda nereye kadar geldiğini gösteriyor:

*Sunucuya bağlanılıyor — adım 1/6, şu ana kadar 14 sn. Bu bir dakikayı bulabilir, lütfen bu sayfayı açık bırakın.*

Bu satırdaki süre artıyor ve aşama değişiyorsa işlem devam ediyordur — sayfayı açık tutun. Altı aşama şunlardır: sunucuya bağlanılıyor, sunucu bekleniyor, bu oyuncunun oyunu başlatılıyor, bu oyuncu oyuna bağlanıyor, oyun görünümü yükleniyor, neredeyse hazır.

### 4. Durursa, sayfa artık NEDENİNİ söylüyor

Bir şey gerçekten ters gittiğinde, cihazınıza birbiriyle ilgisiz birkaç sorundan hangisinin yaşandığı söylenir — iki cümle ve gri bir teknik satırla. **Lütfen her raporda bunların hepsini ekleyin.** Karşılaşabileceğiniz üç mesaj var ve her biri tamamen farklı bir çözüm gerektirir:

- **“Oyununuz ana bilgisayarda çalışıyor ancak bu cihaz ona ulaşamadı.”**\
  Sorun, telefonunuzla host bilgisayar arasındaki ağ yolundadır — misafir Wi-Fi, bir VPN ya da cihazları birbirinden ayıran bir yönlendirici. Host bilgisayardaki oyunda bir sorun yok. 2. ve 6. bölümlere bakın.
- **“Ana bilgisayardaki başka bir program, oyununuzun ihtiyaç duyduğu bağlantı noktasını kullanıyor.”**\
  Cihazınızda değiştirilecek bir şey yok. Host bilgisayarda başka bir şey, oyuncuların ihtiyaç duyduğu portlardan birini tutuyor — çoğunlukla önceki bir oturumdan kalmış bir oyuncu işlemi. Oyunu barındıran kişi bunu kapatmalıdır (Slay the Spire 2'yi yeniden başlatmak sorunu giderir).
- **“Ana bilgisayar, oyununuzun sunulduğu bağlantı noktasını engelliyor.”**\
  Burada da cihazınızda değiştirilecek bir şey yok. Portu engelleyen, host bilgisayarın kendi güvenlik duvarı veya güvenlik yazılımıdır — 5. bölüme bakın.

**En yaygın engelleme durumunda *Katılıyor…* hiç görünmez.** Cihazınız host bilgisayara ulaştıysa ama kendi oyuncunuza verilen porta ulaşamıyorsa, katılma *başarılı olur* — ardından sayfa *Yükleniyor…* ekranına geçer ve orada kalır. Bu ekranda ne ilerleme satırı ne de geri sayım vardır, çünkü host tarafında hiçbir şey başarısız olmamıştır. Göreceğiniz ilk işe yarar şey, sayfa değiştikten yaklaşık **20 saniye** sonra çıkan, yukarıdaki **“bu cihaz ona ulaşamadı”** mesajıdır. Yani *Yükleniyor…* ekranında takıldıysanız, sayfayı yenilemek yerine bu mesaj için yarım dakika bekleyin — yenilemek tüm bekleme süresini baştan başlatır.

Sayfa bunun yerine *Katılıyor…* ekranında kalıp hiç değişmiyorsa, host 75 saniyede pes eder ve *Oyun görünümünüz başlatılamadı; lütfen tekrar deneyin.* mesajını, altında gri bir satırla gösterir. Bu, yukarıdakinden farklı bir hatadır. Her iki durumda da ekranda yazanları kopyalayın.

### 5. Her oyuncu kendi portunu kullanır

Lobi **13337** numaralı porttadır, ardından her oyuncu **13357**, **13367**, **13377** ve devamındaki portları kullanır. Yalnızca 13337'yi açan bir güvenlik duvarı kuralı oyuncu listesine ulaşmanızı sağlar, ancak ikinci adımda başarısız olur. Siz (ya da izlediğiniz bir rehber) böyle bir kural eklediyseniz, onu kaldırın ve bunun yerine **oyun programının kendisine** izin verin — bu, oyunun ihtiyaç duyduğu tüm portları kapsar.

### 6. Windows: oyunun güvenlik duvarından geçmesine izin verin

Önce ağ türünü kontrol edin, çünkü tek başına bu bile pek çok bağlantıyı engeller:

- **Ayarlar > Ağ ve İnternet > Wi-Fi** (veya Ethernet) > ağınıza tıklayın > **Ağ profili türü** ayarını **Özel ağ** yapın.

Ardından oyuna izin verin:

- **Ayarlar > Gizlilik ve güvenlik > Windows Güvenliği > Güvenlik duvarı ve ağ koruması > Bir uygulamaya güvenlik duvarı üzerinden izin ver**
- Listede **Slay the Spire 2** oyununu bulun ve **Özel** kutusunun işaretli olduğundan emin olun. Listede yoksa **Başka bir uygulamaya izin ver...** seçeneğini kullanın ve oyunun `.exe` dosyasını seçin.

Bir noktada Windows güvenlik duvarı uyarısında “İptal” düğmesine bastıysanız, Windows bunu bir engelleme kuralı olarak hatırlar ve bir daha asla sormaz. Bu durumda yukarıdaki girişi kaldırıp yeniden eklemeniz gerekir.

**Adresi host bilgisayarın kendisindeki bir tarayıcıda açmak hiçbir şeyi kanıtlamaz.** Akla ilk gelen deneme budur ve ölçümler bunun yanıltıcı olduğunu gösteriyor: Windows, bir bilgisayarın kendisine giden trafiğini — kendi ağ adresine giden trafiği bile — filtrelemez; bu yüzden güvenlik duvarı tüm telefonları etkin biçimde engellerken bile host bilgisayarın kendi tarayıcısı sayfayı kusursuzca yükler. Bu sizde çalıştıysa, oyunun çalıştığını ve sayfayı sunduğunu gösterir. Güvenlik duvarı hakkında ise hiçbir şey söylemez.

**Ortak** kutusunu yalnızca ağınız Ortak ağ olarak ayarlıysa ve bunu değiştiremiyorsanız işaretleyin. Bu kutuyu işaretlemek, oyunu kafeler ve oteller dahil bağlandığınız her ağda erişilebilir kılar.

### 7. Yönlendirici

Bazı yönlendiriciler aynı Wi-Fi'daki cihazların birbirine ulaşmasını engeller. **AP isolation**, **Client isolation** veya **Wireless isolation** adlı bir ayar arayın (Türkçe arayüzlerde “AP İzolasyonu” olarak da geçebilir) ve kapatın.

Şunu da bilmekte fayda var: **bridge** (köprü) / **access point** (erişim noktası) modu yerine **router** (yönlendirici) modunda kurulmuş bir Wi-Fi genişletici veya powerline adaptörü, Wi-Fi adı aynı görünse bile telefonunuzu host bilgisayardan ayrı bir ağa koyar.

### 8. Düz adresleri engelleyen tarayıcı ayarları

Bazı tarayıcılar her adresi HTTPS'ye zorlamaya çalışır; düz sayısal adres ise HTTPS kullanmaz. (QR ekranında HTTPS kullanan satır **Güvenli bağlantı** satırıdır — yani sorun HTTPS zorlamasıysa bu satırı da denemeye değer.) Adres çubuğunda oyun yerine bir güvenlik uyarısı görünüyorsa şunları kapatıp yeniden deneyin:

- Chrome: **Ayarlar > Gizlilik ve güvenlik > Güvenlik > Her zaman güvenli bağlantılar kullan**
- Firefox: **Ayarlar > Gizlilik ve güvenlik > Yalnızca HTTPS modu**

iPhone'da ayrıca **Ayarlar > Uygulamalar > Safari** bölümünde iCloud Özel Geçişi ve “IP Adresini Gizle” ayarlarını kontrol edin.

### 9. Kendi güvenlik duvarı olan antivirüsler

ESET, Bitdefender, Norton, Kaspersky ve Avast gibi güvenlik paketlerinin Windows'unkinden ayrı, kendi güvenlik duvarı vardır. Oyuna Windows'ta izin vermek bunları hiç etkilemez. Paketin kendi ağ veya güvenlik duvarı ayarlarını kontrol edin ya da engelleyenin bu olup olmadığını görmek için güvenlik duvarını kısa bir süreliğine duraklatın.

### 10. Önceden çalışıyorduysa ve sonra durduysa

Host bilgisayarın adresi, Wi-Fi'a yeniden bağlandığında veya yönlendirici yeniden başlatıldıktan sonra değişebilir. QR ekranını yeniden açın ve tekrar tarayın — yeni adres orada olacaktır.

İstemciyi ana ekranınıza eklediyseniz, bundan sonra ne olacağı onu hangi satırdan yüklediğinize bağlıdır:

- **Web bağlantısı** satırından yüklendiyse: çalışmaya devam eder ve yeni adresi kendisi bulur. Sadece açın — yeniden taramaya gerek yok.
- **Sayısal adresten** veya **Güvenli bağlantı** satırından yüklendiyse: simge eski adresi gösterir ve kendini düzeltemez. Simgeyi silin ve yeniden taradıktan sonra tekrar ekleyin. (Android'de bunun yerine **Web bağlantısı** satırından yüklemek bu sorunu kalıcı olarak önler. iPhone veya iPad'de bu satır çalışamaz — 1. bölüme bakın — bu yüzden orada tek yol simgeyi yeniden eklemektir.)

---

## Hâlâ takıldınız mı? Steam tartışmasına yorum yazın

[Steam tartışmasına](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) bir yorum bırakın — her şeyi yanıtlamanız gerekmez. Aşağıdakilerden bir ya da ikisi bile bir raporla ilgilenmeyi çok daha kolay hale getirir ve ilk soru, diğer hepsinin toplamından daha değerlidir.

### İş nereye kadar ilerliyor?

Bana söyleyebileceğiniz en faydalı şey budur, çünkü her yanıt farklı bir nedene işaret eder:

- tarayıcı hiçbir şey yüklemiyor
- sayfa yükleniyor ama oyuncu listesi hiç görünmüyor
- bir isim seçebiliyorsunuz ama “Katılıyor…” ekranında kalıyor — altındaki ilerleme satırında ne yazdığını ve beklediyseniz hangi mesajı aldığınızı bana söyleyin
- bu aşamayı geçiyor ama bu kez **“Yükleniyor…”** ekranında kalıyor — bu port/güvenlik duvarı durumudur ve en yaygın olanıdır. Yaklaşık 20 saniye sonra “bu cihaz ona ulaşamadı” mesajının çıkıp çıkmadığını bana söyleyin
- sorunsuz bağlandı, sonra koşu sırasında bağlantı koptu

### Ekleyebileceğiniz diğer her şey

- Telefonun gösterdiği mesajın tam metni, altındaki gri satır dahil. Ekranın bir fotoğrafı mükemmel olur.
- Hangi adresi taradığınız — sayısal adresi mi, **.local** adını mı, yoksa web bağlantısını mı.
- Host bilgisayarın işletim sistemi, ayrıca telefon/tablet modeli ve tarayıcı.
- **Her** cihazda mı başarısız oluyor, yoksa yalnızca birinde mi? Bir telefon çalışıp diğeri çalışmıyorsa bu pek çok olasılığı eler.
- Daha önce hiç çalıştı mı ve o zamandan beri bir şey değişti mi?
- Host bilgisayar Wi-Fi'da mı yoksa Ethernet'te mi. Host bilgisayarda veya telefonda çalışan bir VPN var mı. Güvenlik duvarı olan bir antivirüs var mı.

### Host bilgisayardan alabileceğiniz üç şey

- **Bağlantı paneli.** Host bilgisayarda **Kanepede İşbirliği QR Kodu** ekranını açın — **Bağlantılar** paneli bu ekranda, kodun altındadır. Orada görünecek kadar ilerleyen cihazlar listelenir ve ters giden her şey **Bağlantı sorunları** altında tutulur (yanında bir sayıyla). Satırı seçin ve **Raporu kopyala** düğmesini kullanın — bu, başarısız olan adımı, süreleri ve host bilgisayarın kendi teşhisini zaten içeren bir rapor kopyalar. Raporu doğrudan yorumunuza yapıştırın. Rapor ayrıca aşağıdaki iki log dosyasının tam yolunu da belirtir, böylece onları aramak zorunda kalmazsınız.
- **Ana log dosyası.** Windows'ta `%APPDATA%\SlayTheSpire2\logs\godot.log`. Linux'ta `~/.local/share/SlayTheSpire2/logs/godot.log`. macOS'ta `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **Oyuncu başına log.** Katılan her oyuncu için host bilgisayarda arka planda oyunun ayrı bir kopyası çalışır ve her kopya kendi log dosyasını tutar. **Katılma *Katılıyor…* aşamasına ulaşıp ardından zaman aşımına uğradıysa, nedenini açıklayan dosya budur** — yukarıdaki ana log genellikle bunu açıklamaz. Oyuncular 2'den başlayarak numaralandırılır, bu yüzden ilk katılan kişi `slot-2` olur: Linux'ta bu `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` dosyasıdır (evet, iki kez `SlayTheSpire2` — yazım hatası değil); Windows ve macOS yolları da yukarıdaki klasörlerin altında aynı yapıyı izler. Bazı kurulumlarda bunun yerine `couch-coop/seat-logs/slot-2.log` konumunda tek bir dosyadır.

**Hangi satırlar önemli.** Her iki log dosyasında da işe yarayanlar `[couchcoop]` içeren satırlardır — `[INFO] [couchcoop] ...` gibi görünürler — ve bunlara ek olarak, couchcoop'tan hiç bahsetmeyenler dahil tüm `[ERROR]` satırları. Genellikle tek başlarına bunlar yeterlidir.

**Bir log dosyasının tamamını yapıştırmadan önce:** Steam tartışması herkese açıktır ve bir log dosyası, dosya yollarında kendi **SteamID64** numaranızı (7656 ile başlayan ve Steam profilinize işaret eden uzun bir sayı) ve bilgisayarınızın **kullanıcı adını** içerir. Parola *içermez*, diğer oyuncuların hesaplarını da içermez — yalnızca sizinkini. Bunları paylaşmak istemiyorsanız yapıştırmadan önce bu ikisini bul-değiştir ile değiştirmeniz yeterlidir; ya da sadece `[couchcoop]` ve `[ERROR]` satırlarını paylaşın, daha fazlasına ihtiyacım olursa sorarım.

---

Son bir not: katılma adresine ulaşabilen herkes istemciyi açıp oynayabilir, bu yüzden bunu güvendiğiniz bir ağda kullanın.
