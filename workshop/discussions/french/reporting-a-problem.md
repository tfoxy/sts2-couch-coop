# Un problème ? Signalez-le dans la discussion Steam

> Ceci est une traduction de la discussion du Workshop Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Pour poser une question ou signaler un problème, laissez un commentaire dans cette discussion — inutile d'écrire en anglais, vous pouvez écrire en français.

[La discussion Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) est l'endroit pour tout ce qui ne va pas - plantages, un joueur qui ne finit jamais de rejoindre, quelque chose qui s'affiche mal, une partie qui se casse.

**Si votre téléphone ou votre tablette n'arrive pas du tout à atteindre la page pour rejoindre la partie**, lisez d'abord [Impossible de se connecter depuis un téléphone ou une tablette ?](phone-connection-troubleshooting.md) - cette page couvre en détail le Wi-Fi, les pare-feu et les routeurs, et la plupart des problèmes de connexion s'y résolvent.

---

## Ce qu'il faut inclure

Pas besoin de répondre à tout - les deux premiers points valent plus que tout le reste réuni.

### 1. Ce qui s'est passé, et ce à quoi vous vous attendiez

Une ou deux phrases suffisent. S'il y avait un message d'erreur à l'écran, citez-le exactement, y compris l'éventuelle ligne grise plus petite en dessous. Une photo ou une capture d'écran, c'est parfait.

### 2. Si le problème survient en rejoignant la partie ou dans la salle d'attente : le rapport de connexion

*Si votre problème survient plus tard - pendant une partie, ou dans le jeu lui-même -, passez directement à l'étape 3.*

Depuis la salle d'attente, ouvrez l'écran **Code QR de Couch Co-Op**. Le panneau **Connexions** s'y trouve, sous le code. Tout ce qui a mal tourné est conservé sous **Problèmes de connexion** (suivi d'un nombre).

Sélectionnez la ligne en échec et cliquez sur **Copier le rapport**, puis collez-le dans votre commentaire. Quand le problème survient en rejoignant la partie, c'est de loin l'élément le plus utile que vous puissiez joindre : il contient déjà l'étape en échec, les durées, le diagnostic de l'hôte lui-même et les chemins des fichiers journaux décrits ci-dessous.

### 3. Les fichiers journaux

Il en existe deux sortes, et celle qui compte dépend du problème.

**Le journal principal du jeu**, sur l'ordinateur hôte :

- Windows : `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux : `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS : `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Le journal de chaque joueur.** Chaque joueur qui rejoint obtient sa propre copie du jeu, qui tourne en arrière-plan sur l'ordinateur hôte, et chacune tient son propre journal. **Si un joueur est resté bloqué en rejoignant la partie, c'est ce fichier qui explique pourquoi** - le journal principal ci-dessus, en général, non.

Les joueurs sont numérotés à partir de 2, donc la première personne qui vous rejoint est `slot-2`. Sous Linux, le journal de ce joueur se trouve ici :

`~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`

(Oui, `SlayTheSpire2` apparaît vraiment deux fois - ce n'est pas une faute de frappe.) Sous Windows et macOS, la structure est la même, sous le dossier de la liste ci-dessus. Sur certaines configurations, c'est plutôt un seul fichier, `couch-coop/seat-logs/slot-2.log`. Dans tous les cas, **le rapport de l'étape 2 indique le chemin exact**, donc le copier en premier vous évite de chercher.

**Quelles lignes comptent.** Dans l'un ou l'autre fichier, les lignes utiles contiennent `[couchcoop]` - elles ressemblent à `[INFO] [couchcoop] ...` -, ainsi que toutes les lignes `[ERROR]`, même celles qui ne mentionnent pas couchcoop. Ces lignes suffisent généralement à elles seules.

**Avant de coller un journal entier :** la discussion Steam est publique, et un journal contient votre propre **SteamID64** (un long nombre commençant par 7656, qui mène à votre profil Steam) et le **nom d'utilisateur** de votre ordinateur, dans les chemins de fichiers. Il ne contient *pas* de mots de passe, ni les comptes des autres joueurs - seulement le vôtre. Si vous préférez ne pas publier cela, un rechercher-remplacer sur ces deux éléments avant de coller suffit, ou publiez simplement les lignes `[couchcoop]` et `[ERROR]`, et je vous demanderai si j'ai besoin de plus.

### 4. Versions et mods

- Si vous êtes sur la branche **stable** ou sur la branche **bêta publique** du jeu.
- **Quels autres mods sont installés.** Chaque copie de joueur en arrière-plan charge les mêmes mods que l'hôte, donc un autre mod peut empêcher un joueur de finir de rejoindre, même quand la partie de l'hôte semble parfaitement normale.
- Le système d'exploitation de l'hôte.
- La version de CouchCoop, si vous la connaissez - sinon, je partirai du principe que c'est la dernière.

### 5. Tout ce qui permet de cerner le problème

- Est-ce que ça arrive à chaque fois, ou seulement parfois ?
- Est-ce que ça arrive pour tous les joueurs, ou pour un seul ?
- Est-ce que ça a déjà fonctionné, et est-ce que quelque chose a changé depuis - une mise à jour du jeu, un nouveau mod ?

---

## Une chose à savoir avant de signaler un problème

Lancer la partie d'un joueur peut prendre jusqu'à une minute, et sur une machine plus lente, cela en prendra la majeure partie. C'est normal, ce n'est pas une panne. Pendant ce temps, la page pour rejoindre la partie compte les secondes et change d'étape sous *Connexion à la partie…* - si cette ligne bouge encore, rien n'a mal tourné pour l'instant, alors gardez la page ouverte.
