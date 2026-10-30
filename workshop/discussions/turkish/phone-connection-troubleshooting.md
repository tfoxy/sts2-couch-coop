# Telefon veya tabletten bağlanamıyor musun?

> Bu metin, Steam Atölyesi'ndeki [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) tartışmasının çevirisidir. Soru sormak veya bir sorun bildirmek için o tartışmaya yorum bırak — İngilizce yazman gerekmez, Türkçe yazabilirsin.

Telefonun veya tabletin bağlanamıyorsa bu adımları dene. Çökmeler veya oyun sırasında yaşanan sorunlar için [Bir sorun mu var? Steam tartışmasına yaz](reporting-a-problem.md) yazısına bak.

### 1. Bağlantı ayarlarını seç

Oyunun çalıştığı bilgisayarda **Couch Co-Op QR Kodu** ekranını aç.

- **Ağ arayüzü** (solda): bilgisayar yönlendiriciye kabloyla bağlıysa **Kablolu (Ethernet)**, kablosuz bağlıysa **Wi-Fi** seç. Telefonunun kullandığı yönlendiriciye olan bağlantıyı seç. **PC adı (.local)** seçeneğini atla.
- **Bağlantı yöntemi** (sağda): “(HTTPS)” yazmayan **Doğrudan adres** seçeneğini seç. Adres `http://` ile başlamalı; örneğin `http://192.168.1.5:13337`.

Bu ayarları değiştirdikten sonra QR kodunu yeniden tara.

Sorunu araştırırken **Doğrudan adres** kullan. HTTPS yöntemleri performans ve güvenlik için sunulan isteğe bağlı seçeneklerdir; ek kurulum veya bağlantı koşulları gerektirirler.

### 2. Telefonun ağını kontrol et

- Telefonu **Misafir** ağına değil, evindeki Wi-Fi ağına bağla. Bilgisayar aynı yönlendiriciye Wi-Fi veya kabloyla bağlanabilir.
- Telefonun mobil veri yerine Wi-Fi kullandığından emin ol.
- Telefon veya bilgisayardaki VPN bağlantılarını geçici olarak kes. Telefonda VPN bağlantısı kullanan reklam engelleyiciler de buna dâhil.

**Sayfa açılıyor ama katılma işlemi takılıyorsa 6. adıma geç.**

### 3. Windows: oyunun güvenlik duvarından geçmesine izin ver

Ev ağında:

1. **Ayarlar > Ağ ve İnternet > Wi-Fi** (veya Ethernet) > ağına tıkla > **Ağ profili türü** ayarını **Özel ağ** yap.
2. **Ayarlar > Gizlilik ve güvenlik > Windows Güvenliği > Güvenlik duvarı ve ağ koruması > Bir uygulamaya güvenlik duvarı üzerinden izin ver**
3. Listede **Slay the Spire 2** oyununu bul ve **Özel** kutusunun işaretli olduğundan emin ol. Listede yoksa **Başka bir uygulamaya izin ver...** seçeneğini kullan ve oyunun `.exe` dosyasını seç.

Daha önce oyunun güvenlik duvarı istemini iptal ettiysen engellenen kaydını kaldır ve oyunu yeniden ekle.

Antivirüsünün kendi güvenlik duvarı varsa oyuna orada da izin ver.

Adresi oyunun çalıştığı bilgisayarda açmak, güvenlik duvarının telefonun bağlanmasına izin verip vermediğini test etmez.

### 4. Tarayıcının HTTPS’yi zorlayıp zorlamadığını kontrol et

**Doğrudan adres** yöntemi `http://` kullanır. Tarayıcın bunu `https://` olarak değiştirmeye çalışıyorsa güvenli bağlantı ayarını kontrol et:

- Chrome: **Ayarlar > Gizlilik ve güvenlik > Güvenlik > Her zaman güvenli bağlantılar kullan**
- Firefox: **Ayarlar > Gizlilik ve güvenlik > Bağlantı ve yazılım güvenliği > Gelişmiş ayarlar > Yalnızca HTTPS modu**

HTTP adresine izin ver, ardından QR kodunu yeniden tara. Bilgisayarda **Doğrudan adres** seçili kalsın.

### 5. Yönlendiriciyi kontrol et

Misafir Wi-Fi ağı çoğu zaman cihazların birbiriyle iletişim kurmasını engeller. Evin ana ağını kullan.

İki cihaz da zaten o ağdaysa yönlendiricide **AP isolation**, **Client isolation** veya **Wireless isolation** ayarının açık olup olmadığını kontrol et. Bu ayarlar cihazların birbirine ulaşmasını engeller.

Wi-Fi menzil genişletici kullanıyorsan ayrı bir ağ oluşturmak yerine **erişim noktası** (access point) veya **köprü** (bridge) modunda olduğundan emin ol.

### 6. Sayfa açılıyor ama katılmak zaman alıyorsa

Bir oyuncunun oyununu başlatmak bir dakikaya kadar sürebilir. **Katılıyor…** altındaki ilerleme satırı aşama değiştirdiği sürece sayfayı açık tut.

Hata çıkarsa ekran görüntüsü al veya varsa küçük gri satır da dâhil olmak üzere metni aynen kopyala.

Hata olmadan **Katılıyor…** veya **Yükleniyor…** üzerinde kalıyorsa yorumunda son ilerleme mesajını belirt.

### 7. Önceden çalışıyorsa

Ağa yeniden bağlanınca veya yönlendirici yeniden başlatılınca bilgisayarın adresi değişmiş olabilir. QR ekranını aç ve yeniden tara.

Eski bir yer imi veya ana ekran kısayolu artık çalışmıyorsa yeni taradığın adresi kullanarak değiştir.

---

## Hâlâ bağlanamıyor musun? Steam tartışmasına yaz

[Steam tartışmasında](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) şunlarla başla:

- Nereye kadar ilerlediği: sayfa açılmıyor, oyuncu listesi yok, katılma/yükleme takılıyor veya oyun sırasında bağlantı kopuyor.
- Ekran görüntüsü veya hata mesajının tam metni.
- Bilgisayarın işletim sistemi, telefon modeli ve tarayıcı.
- Tüm telefonlarda mı yoksa sadece birinde mi başarısız olduğu.

### Bağlantı raporunu kopyala

Bilgisayarda **Couch Co-Op QR Kodu** ekranını aç ve **Bağlantılar** paneline bak. **Bağlantı sorunları** altındaki başarısız bağlantıyı seç, **Raporu kopyala** seçeneğini kullan ve raporu yorumuna yapıştır.

Orada hiçbir bağlantı görünmüyorsa bunu söyle ve yukarıdaki bilgileri paylaş.

Rapor ilgili günlük dosyalarının yollarını içerir. Günlükler gerekirse [Bir sorun mu var? Steam tartışmasına yaz](reporting-a-problem.md) yazısı onları nasıl bulacağını açıklar. Günlükleri herkese açık paylaşmadan önce Steam hesap kimliğini ve bilgisayar kullanıcı adını gizli tutmak istiyorsan bunları kaldır.

Modu güvendiğin bir ağda kullan: katılma adresine ulaşabilen herkes istemciyi açıp oynayabilir.
