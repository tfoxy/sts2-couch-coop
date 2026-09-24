# Impossible de se connecter depuis un téléphone ou une tablette ?

> Ceci est une traduction de la discussion du Workshop Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Pour poser une question ou signaler un problème, laissez un commentaire dans cette discussion — inutile d'écrire en anglais, vous pouvez écrire en français.

La plupart des problèmes de connexion se résument à une poignée de causes. Cette liste va à peu près de la plus fréquente à la plus rare, donc mieux vaut la suivre dans l'ordre.

*Si votre téléphone atteint sans problème la page pour rejoindre la partie et que le souci est ailleurs - un plantage, un joueur qui ne finit jamais de rejoindre, quelque chose qui ne va pas dans le jeu lui-même -, consultez plutôt [Un problème ? Signalez-le dans la discussion Steam](reporting-a-problem.md).*

---

## Solutions à essayer

### 1. Choisissez une autre adresse sur l'écran du code QR

L'écran du code QR propose un sélecteur avec plusieurs façons de joindre l'hôte. Si celle que vous avez scannée ne fonctionne pas, choisissez-en une autre et scannez à nouveau.

Privilégiez l'adresse numérique simple (quelque chose comme **192.168.1.5:13337**). C'est celle qui dépend du moins d'éléments. Le nom en **.local** et le lien web dépendent tous deux de choses extérieures au mod - votre routeur, une connexion Internet, les autorisations du navigateur - et peuvent donc échouer sur un réseau où l'adresse numérique fonctionne très bien.

**Sur un iPhone ou un iPad, ignorez complètement la ligne *Lien web*.** Safari - et tous les autres navigateurs sur iOS, puisqu'ils reposent tous sur Safari - refuse qu'une page chargée depuis Internet accède à quoi que ce soit sur votre réseau domestique. C'est une règle du navigateur, pas un réglage : il n'y a donc rien à autoriser et rien à modifier. La page se chargera, puis vous dira que le jeu n'a pas répondu, sur n'importe quel réseau et quelle que soit la configuration de votre pare-feu. Sur un iPhone ou un iPad, utilisez **Adresse simple** ou **Lien sécurisé**. (La page le dit désormais elle-même, si vous allez jusque-là.)

### 2. Vérifiez que le téléphone est vraiment sur le même réseau

- Le même Wi-Fi que l'ordinateur hôte, et pas le réseau **Invité**. Les réseaux invités empêchent généralement les appareils de communiquer entre eux, ce qui est justement ce dont on a besoin ici.
- Pas en données mobiles. Si le Wi-Fi n'a pas d'accès à Internet, les téléphones basculent parfois d'eux-mêmes sur les données mobiles sans vous prévenir.
- **Désactivez tout VPN sur le téléphone.** C'est un piège dans lequel tombent beaucoup de gens. Les bloqueurs de publicité et les applications de « DNS privé » qui fonctionnent comme un VPN comptent aussi.

### 3. Lisez ce que la page affiche pendant qu'elle rejoint la partie

Lancer la partie d'un joueur peut prendre jusqu'à une minute, et c'est normal, pas une panne. Pendant ce temps, la page indique désormais où elle en est, sur une ligne sous *Connexion à la partie…* :

*Connexion à l'hôte — étape 1 sur 6, 14 s écoulées. Cela peut prendre jusqu'à une minute, gardez cette page ouverte.*

Si cette ligne compte les secondes et change d'étape, tout fonctionne - gardez la page ouverte. Les six étapes sont « Connexion à l'hôte », « En attente de l'hôte », « Démarrage du jeu de ce joueur », « Connexion de ce joueur à la partie », « Chargement de la vue de jeu » et « Presque prêt ».

### 4. Si ça bloque, la page vous dit désormais POURQUOI

Quand quelque chose tourne vraiment mal, votre appareil apprend de laquelle de plusieurs causes sans rapport entre elles il s'agit - en deux phrases, plus une ligne technique grise. **Merci de tout inclure dans votre signalement.** Il y a trois messages possibles, et ils demandent des solutions complètement différentes :

- « **Votre jeu tourne sur l'ordinateur hôte, mais cet appareil n'a pas réussi à l'atteindre.** »\
  C'est le chemin réseau entre votre téléphone et l'hôte - Wi-Fi invité, VPN ou routeur qui isole les appareils les uns des autres. La partie de l'hôte n'a aucun problème. Voir les sections 2 et 6.
- « **Un autre programme de l'ordinateur hôte utilise le port dont votre jeu a besoin.** »\
  Rien à changer sur votre appareil. Sur l'hôte, autre chose occupe l'un des ports dont chaque joueur a besoin - le plus souvent un processus de joueur resté d'une session précédente. La personne qui héberge doit le fermer (redémarrer Slay the Spire 2 suffit à le faire disparaître).
- « **L'ordinateur hôte bloque le port sur lequel votre jeu est diffusé.** »\
  Là non plus, rien à changer sur votre appareil. C'est le pare-feu ou le logiciel de sécurité de l'hôte lui-même qui le bloque - voir la section 5.

**Le cas de blocage le plus courant n'affiche pas du tout *Connexion à la partie…*.** Si votre appareil a atteint l'hôte mais ne peut pas atteindre le port attribué à votre propre joueur, vous *parvenez* à rejoindre la partie - puis la page passe à *Chargement…* et y reste. Il n'y a ni ligne de progression ni compte à rebours sur cet écran, car du point de vue de l'hôte, rien n'a échoué. La première chose utile que vous verrez est le message « **n'a pas réussi à l'atteindre** » ci-dessus, environ **20 secondes** après le changement de page. Donc, si vous êtes bloqué sur *Chargement…*, attendez une demi-minute que ce message apparaisse plutôt que de recharger - recharger relance toute l'attente.

Si au contraire la page reste sur *Connexion à la partie…* sans jamais changer, l'hôte abandonne au bout de 75 secondes avec « *Impossible de démarrer l'affichage du jeu. Veuillez réessayer.* » et une ligne grise en dessous. C'est un échec différent de celui ci-dessus. Dans les deux cas, copiez ce qui est affiché.

### 5. Chaque joueur utilise son propre port

La salle d'attente est sur le port **13337**, puis chaque joueur utilise **13357**, **13367**, **13377** et ainsi de suite. Une règle de pare-feu qui n'ouvre que le 13337 vous permet d'atteindre la liste des joueurs, puis échoue à la deuxième étape. Si vous (ou un guide que vous avez suivi) en avez ajouté une, supprimez-la et autorisez plutôt **le programme du jeu** - cela couvre tous les ports dont il a besoin.

### 6. Windows : autorisez le jeu à travers le pare-feu

Vérifiez d'abord le type de réseau, car cela seul bloque beaucoup de connexions :

- **Paramètres > Réseau et Internet > Wi-Fi** (ou Ethernet) > cliquez sur votre réseau > réglez **Type de profil réseau** sur **Réseau privé**.

Ensuite, autorisez le jeu :

- **Paramètres > Confidentialité et sécurité > Sécurité Windows > Pare-feu et protection réseau > Autoriser une application via le pare-feu**
- Trouvez **Slay the Spire 2** dans la liste et vérifiez que **Privé** est coché. S'il n'est pas dans la liste, utilisez **Autoriser une autre application...** et parcourez jusqu'au fichier `.exe` du jeu.

Si vous avez un jour répondu « Annuler » à une invite du pare-feu Windows, Windows l'a mémorisé comme une règle de blocage et ne vous posera plus jamais la question. Dans ce cas, vous devez supprimer l'entrée ci-dessus et l'ajouter à nouveau.

**Ouvrir l'adresse dans un navigateur sur le PC hôte lui-même ne prouve rien.** C'est le premier réflexe, et des mesures montrent qu'il est trompeur : Windows ne filtre pas le trafic d'un ordinateur vers lui-même - pas même vers sa propre adresse réseau -, donc même avec un pare-feu qui bloque activement tous les téléphones, le navigateur de l'hôte charge parfaitement la page. Si cela a fonctionné chez vous, cela vous apprend que le jeu tourne et sert la page. Cela ne dit absolument rien du pare-feu.

Ne cochez **Public** que si votre réseau est configuré en Public et que vous ne pouvez pas le changer. Le cocher rend le jeu accessible sur n'importe quel réseau auquel vous vous connectez, y compris dans les cafés et les hôtels.

### 7. Le routeur

Certains routeurs empêchent les appareils connectés au même Wi-Fi de communiquer entre eux. Cherchez un réglage appelé **AP isolation**, **Client isolation** ou **Wireless isolation** (souvent « isolation AP » ou « AP isolé » en français) et désactivez-le.

À savoir aussi : un répéteur Wi-Fi ou un adaptateur CPL configuré en mode **routeur** plutôt qu'en mode **pont** (bridge) / **point d'accès** (access point) place votre téléphone sur un réseau distinct de celui de l'hôte, même si le nom du Wi-Fi semble identique.

### 8. Réglages du navigateur qui bloquent les adresses simples

Certains navigateurs essaient d'imposer HTTPS pour toutes les adresses, ce que l'adresse numérique simple n'utilise pas. (La ligne **Lien sécurisé** de l'écran du code QR, elle, l'utilise - donc si le HTTPS forcé est en cause, cette ligne vaut aussi la peine d'être essayée.) Si la barre d'adresse affiche un avertissement de sécurité au lieu du jeu, désactivez ces options et réessayez :

- Chrome : **Paramètres > Confidentialité et sécurité > Sécurité > Toujours utiliser une connexion sécurisée**
- Firefox : **Paramètres > Vie privée et sécurité > Mode HTTPS uniquement**

Sur iPhone, vérifiez aussi dans **Réglages > Apps > Safari** le Relais privé iCloud et « Masquer l'adresse IP ».

### 9. Antivirus avec son propre pare-feu

Les suites de sécurité comme ESET, Bitdefender, Norton, Kaspersky et Avast ont leur propre pare-feu, distinct de celui de Windows. Autoriser le jeu dans Windows ne change rien pour celles-ci. Vérifiez les réglages réseau ou pare-feu de la suite elle-même, ou mettez brièvement son pare-feu en pause pour voir si c'est lui qui bloque.

### 10. Si ça fonctionnait avant et que ça ne marche plus

L'adresse de l'ordinateur hôte peut changer quand il se reconnecte au Wi-Fi ou après un redémarrage du routeur. Rouvrez l'écran du code QR et scannez à nouveau - la nouvelle adresse y sera.

Si vous avez ajouté le client à votre écran d'accueil, la suite dépend de la ligne depuis laquelle vous l'avez installé :

- Installé depuis la ligne **Lien web** : il continue de fonctionner et trouve la nouvelle adresse tout seul. Ouvrez-le simplement - pas besoin de scanner à nouveau.
- Installé depuis l'**adresse numérique** ou la ligne **Lien sécurisé** : l'icône pointe vers l'ancienne adresse et ne peut pas s'en remettre. Supprimez-la et ajoutez-la à nouveau après avoir scanné de nouveau. (Sur Android, installer plutôt depuis la ligne **Lien web** évite définitivement ce problème. Sur un iPhone ou un iPad, cette ligne ne peut pas fonctionner - voir la section 1 -, donc rajouter l'icône est la seule solution.)

---

## Toujours bloqué ? Commentez dans la discussion Steam

Laissez un commentaire dans [la discussion Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) - pas besoin de répondre à tout. Même une ou deux de ces informations rendent un signalement bien plus facile à traiter, et la première question vaut plus que toutes les autres réunies.

### Jusqu'où ça va ?

C'est l'information la plus utile que vous puissiez me donner, car chaque réponse pointe vers une cause différente :

- le navigateur ne charge jamais rien du tout
- la page se charge, mais la liste des joueurs n'apparaît jamais
- vous pouvez choisir un nom, mais ça reste sur « Connexion à la partie… » - dites-moi ce qu'indiquait la ligne de progression en dessous, et quel message vous avez eu si vous avez attendu
- ça passe cette étape et reste plutôt sur « **Chargement…** » - c'est le cas port/pare-feu, et c'est le plus courant. Dites-moi si le message « n'a pas réussi à l'atteindre » est apparu au bout d'environ 20 secondes
- la connexion a bien fonctionné, puis a été coupée pendant la partie

### Tout ce que vous pouvez ajouter d'autre

- Le message exact affiché par le téléphone, y compris la ligne grise en dessous. Une photo de l'écran, c'est parfait.
- L'adresse que vous avez scannée - l'adresse numérique, le nom en **.local** ou le lien web.
- Le système d'exploitation de l'hôte, ainsi que le modèle et le navigateur du téléphone ou de la tablette.
- Est-ce que ça échoue sur **tous** les appareils, ou sur un seul ? Si un téléphone fonctionne et pas un autre, cela élimine beaucoup de pistes.
- Est-ce que ça a déjà fonctionné, et est-ce que quelque chose a changé depuis ?
- L'hôte est-il en Wi-Fi ou en Ethernet ? Un VPN tourne-t-il sur l'hôte ou sur le téléphone ? Un antivirus avec pare-feu ?

### Trois choses que l'ordinateur hôte peut vous fournir

- **Le panneau des connexions.** Sur l'hôte, ouvrez l'écran **Code QR de Couch Co-Op** - le panneau **Connexions** s'y trouve, sous le code. Les appareils qui sont allés assez loin pour y apparaître sont listés, et tout ce qui a mal tourné est conservé sous **Problèmes de connexion** (suivi d'un nombre). Sélectionnez la ligne et utilisez **Copier le rapport** - cela copie un rapport qui contient déjà l'étape en échec, les durées et le diagnostic de l'hôte lui-même. Collez-le directement dans votre commentaire. Il indique aussi le chemin exact des deux fichiers journaux ci-dessous, ce qui vous évite de les chercher.
- **Le fichier journal principal.** Sous Windows, `%APPDATA%\SlayTheSpire2\logs\godot.log`. Sous Linux, `~/.local/share/SlayTheSpire2/logs/godot.log`. Sous macOS, `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **Le journal de chaque joueur.** Chaque joueur qui rejoint obtient sa propre copie du jeu, qui tourne en arrière-plan sur l'hôte, et chacune tient son propre journal. **Si la page a atteint *Connexion à la partie…* puis a expiré, c'est ce fichier qui explique pourquoi** - le journal principal ci-dessus, en général, non. Les joueurs sont numérotés à partir de 2, donc la première personne qui rejoint est `slot-2` : sous Linux, c'est `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` (oui, `SlayTheSpire2` deux fois - ce n'est pas une faute de frappe), et les chemins Windows et macOS suivent la même structure sous leurs dossiers ci-dessus. Sur certaines configurations, c'est plutôt un seul fichier, `couch-coop/seat-logs/slot-2.log`.

**Quelles lignes comptent.** Dans l'un ou l'autre journal, les lignes utiles contiennent `[couchcoop]` - elles ressemblent à `[INFO] [couchcoop] ...` -, ainsi que toutes les lignes `[ERROR]`, même celles qui ne mentionnent pas couchcoop. Elles suffisent généralement à elles seules.

**Avant de coller un journal entier :** la discussion Steam est publique, et un journal contient votre propre **SteamID64** (un long nombre commençant par 7656, qui mène à votre profil Steam) et le **nom d'utilisateur** de votre ordinateur, dans les chemins de fichiers. Il ne contient *pas* de mots de passe, ni les comptes des autres joueurs - seulement le vôtre. Si vous préférez ne pas publier cela, un rechercher-remplacer sur ces deux éléments avant de coller suffit, ou publiez simplement les lignes `[couchcoop]` et `[ERROR]`, et je vous demanderai si j'ai besoin de plus.

---

Une dernière remarque : toute personne qui peut atteindre l'adresse pour rejoindre la partie peut ouvrir le client et jouer, alors utilisez-le sur un réseau de confiance.
