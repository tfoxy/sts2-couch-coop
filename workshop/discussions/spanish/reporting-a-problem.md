# ¿Tienes algún problema? Publícalo en la discusión de Steam

> Esta es una traducción de la discusión del Workshop de Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Para hacer una pregunta o informar de un problema, deja un comentario en esa discusión; no hace falta que escribas en inglés, puedes hacerlo en español.

Publica en [la discusión de Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) si algo falla: un cierre inesperado, un jugador que no termina de unirse, algo que se ve mal en pantalla o una partida que deja de funcionar.

**Si tu teléfono o tableta no puede ni abrir la página para unirse**, lee primero [¿No puedes conectarte desde un teléfono o una tableta?](phone-connection-troubleshooting.md). La mayoría de los problemas de conexión se deben a un ajuste de la red Wi-Fi, el firewall o el router que se explica en esa guía.

### Antes de informar de un bloqueo al unirse

Iniciar el juego de un jugador puede tardar hasta un minuto, sobre todo en un ordenador más lento. Mientras la línea debajo de **Uniéndote…** en la página para unirse siga contando y cambiando, sigue trabajando, así que deja la página abierta.

---

## Qué incluir

No hace falta que respondas a todo. Los dos primeros puntos son los que más ayudan.

### 1. Qué ha pasado y qué esperabas que pasara

Con una o dos frases basta. Si apareció un error, cópialo tal cual, incluida la línea gris más pequeña que hay debajo, o publica una captura o una foto de la pantalla.

### 2. El informe de conexión (problemas al unirse o en la sala)

*Omite este punto si el problema ocurrió durante una partida.*

En el ordenador, abre **Código QR de Couch Co-Op** y busca **Conexiones**. Selecciona la conexión que ha fallado en **Problemas de conexión**, elige **Copiar informe** y pégalo en tu comentario.

El informe indica qué paso ha fallado y cuánto ha tardado cada uno, incluye lo que el anfitrión cree que ha fallado y muestra las rutas de los archivos de registro de abajo.

### 3. Los archivos de registro

Si has copiado el informe de conexión, ya contiene las rutas exactas.

**El registro del juego**, en el ordenador anfitrión:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Los registros de los jugadores.** Cada jugador que se une ejecuta su propia copia oculta del juego en el ordenador anfitrión, con su propio registro. Si un jugador se quedó atascado al unirse, su registro suele explicar por qué; el del juego normalmente no lo explica.

El primer jugador que se une es `slot-2`, el siguiente `slot-3` y así sucesivamente. Para `slot-2`:

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

Si no hay una carpeta `headless-slots`, el registro es `couch-coop/seat-logs/slot-2.log`, dentro de la misma carpeta `SlayTheSpire2` que el registro del juego.

**Qué líneas importan.** En ambos registros, las líneas que más necesito son las que contienen `[couchcoop]` (por ejemplo, `[INFO] [couchcoop] ...`), además de cualquier línea `[ERROR]`, aunque no mencione couchcoop. Normalmente esas líneas bastan.

**Antes de pegar un registro entero:** esta discusión es pública. Un registro contiene tu SteamID64 (un número largo que empieza por 7656 y lleva a tu perfil de Steam) y el nombre de usuario de tu ordenador en las rutas de archivo. No contiene contraseñas ni cuentas de otros jugadores. Si prefieres no compartir esos dos datos, sustitúyelos antes de pegarlo o publica solo las líneas `[couchcoop]` y `[ERROR]` y, si necesito más, te lo pediré.

### 4. Versiones y mods

- Si estás en la rama **estable** o en la rama **beta pública** del juego.
- **Qué otros mods tienes instalados.** La copia del juego de cada jugador carga los mismos mods que el anfitrión, así que otro mod puede impedir que un jugador se una aunque el juego del anfitrión funcione bien.
- El sistema operativo del anfitrión.
- Tu versión de CouchCoop, si la sabes. Si no, daré por hecho que es la más reciente.

### 5. Cualquier cosa que ayude a acotarlo

- ¿Pasa siempre o solo a veces?
- ¿Le pasa a todos los jugadores o solo a uno?
- ¿Funcionaba antes y ha cambiado algo desde entonces, como una actualización del juego o un mod nuevo?
