# Un problème ? Signalez-le dans la discussion Steam

> Ceci est une traduction de la discussion du Workshop Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Pour poser une question ou signaler un problème, laissez un commentaire dans cette discussion — inutile d'écrire en anglais, vous pouvez écrire en français.

Signalez dans [la discussion Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) ce qui ne va pas : un plantage, un joueur qui n'arrive pas à finir de rejoindre, un affichage incorrect, une partie qui ne fonctionne plus.

**Si votre téléphone ou votre tablette n'arrive pas du tout à ouvrir la page pour rejoindre la partie**, lisez d'abord [Impossible de se connecter depuis un téléphone ou une tablette ?](phone-connection-troubleshooting.md). La plupart des problèmes de connexion viennent d'un réglage du Wi-Fi, du pare-feu ou du routeur expliqué dans ce guide.

### Avant de signaler un blocage en rejoignant la partie

Lancer la partie d'un joueur peut prendre jusqu'à une minute, surtout sur un ordinateur plus lent. Tant que la ligne sous **Connexion…** sur la page pour rejoindre la partie continue de compter et de changer, le chargement est en cours : gardez la page ouverte.

---

## Ce qu'il faut inclure

Pas besoin de répondre à tout. Les deux premiers points sont les plus utiles.

### 1. Ce qui s'est passé, et ce à quoi vous vous attendiez

Une ou deux phrases suffisent. Si une erreur est apparue, copiez-la exactement, y compris la petite ligne grise en dessous, ou publiez une capture ou une photo de l'écran.

### 2. Le rapport de connexion (problèmes en rejoignant la partie ou dans la salle d'attente)

*Passez cette étape si le problème est survenu pendant une partie.*

Sur l'ordinateur, ouvrez **Code QR de Couch Co-Op**, puis regardez sous **Connexions**. Sélectionnez la connexion en échec sous **Problèmes de connexion**, choisissez **Copier le rapport** et collez-le dans votre commentaire.

Il indique quelle étape a échoué et combien de temps chaque étape a pris, précise ce qui semble avoir mal tourné selon l'hôte et donne les chemins des fichiers journaux ci-dessous.

### 3. Les fichiers journaux

Si vous avez copié le rapport de connexion, il contient déjà les chemins exacts.

**Le journal du jeu**, sur l'ordinateur hôte :

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Les journaux des joueurs.** Chaque joueur qui rejoint la partie a sa propre copie du jeu qui tourne en arrière-plan sur l'ordinateur hôte, avec son propre journal. Si un joueur est resté bloqué en rejoignant la partie, son journal explique généralement pourquoi ; celui du jeu, généralement pas.

Le premier joueur qui rejoint la partie est `slot-2`, le suivant `slot-3`, et ainsi de suite. Pour `slot-2` :

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

S'il n'y a pas de dossier `headless-slots`, le journal est `couch-coop/seat-logs/slot-2.log`, dans le même dossier `SlayTheSpire2` que le journal du jeu.

**Quelles lignes comptent.** Dans les deux journaux, les lignes dont j'ai le plus besoin sont celles qui contiennent `[couchcoop]` (par exemple `[INFO] [couchcoop] ...`), ainsi que toutes les lignes `[ERROR]`, même celles qui ne mentionnent pas couchcoop. Elles suffisent généralement.

**Avant de coller un journal entier :** cette discussion est publique. Un journal contient votre SteamID64 (un long nombre commençant par 7656 qui renvoie à votre profil Steam) et le nom d'utilisateur de votre ordinateur dans les chemins de fichiers. Il ne contient ni mots de passe ni comptes d'autres joueurs. Si vous préférez ne pas partager ces deux éléments, remplacez-les avant de coller le journal, ou publiez seulement les lignes `[couchcoop]` et `[ERROR]` et je vous demanderai si j'ai besoin de plus.

### 4. Versions et mods

- Si vous êtes sur la branche **stable** ou sur la branche **bêta publique** du jeu.
- **Les autres mods que vous avez installés.** La copie du jeu de chaque joueur charge les mêmes mods que l'hôte. Un autre mod peut donc empêcher un joueur de rejoindre la partie même quand le jeu de l'hôte fonctionne bien.
- Le système d'exploitation de l'hôte.
- Votre version de CouchCoop, si vous la connaissez. Sinon, je partirai du principe que c'est la dernière.

### 5. Tout ce qui permet de cerner le problème

- Est-ce que ça arrive à chaque fois, ou seulement parfois ?
- Est-ce que ça arrive pour tous les joueurs, ou pour un seul ?
- Est-ce que ça fonctionnait avant, et est-ce que quelque chose a changé depuis, comme une mise à jour du jeu ou un nouveau mod ?
