# ¿Tienes algún problema? Publícalo en la discusión de Steam

> Esta es una traducción de la discusión del Workshop de Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Para hacer una pregunta o informar de un problema, deja un comentario en esa discusión; no hace falta que escribas en inglés, puedes hacerlo en español.

[La discusión de Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) es el sitio para cualquier cosa que vaya mal: cierres inesperados, un jugador que nunca termina de unirse, algo que se ve mal en pantalla, una partida que se rompe.

**Si tu teléfono o tableta no llega ni siquiera a la página para unirse**, lee primero [¿No puedes conectarte desde un teléfono o una tableta?](phone-connection-troubleshooting.md): ahí se explican en detalle la red Wi-Fi, los firewalls y los routers, y la mayoría de los problemas de conexión se resuelven con eso.

---

## Qué incluir

No hace falta que respondas a todo: los dos primeros puntos valen más que todos los demás juntos.

### 1. Qué ha pasado y qué esperabas que pasara

Con una o dos frases basta. Si apareció un mensaje de error en pantalla, cópialo tal cual, incluida cualquier línea gris más pequeña que haya debajo. Una foto o una captura de pantalla es perfecta.

### 2. Si el problema es al unirse o en la sala: el informe de conexión

*Si tu problema ocurre más tarde (durante una partida o en el propio juego), pasa directamente al paso 3.*

Desde la sala, abre la pantalla **Código QR de Couch Co-Op**. El panel **Conexiones** está en ella, debajo del código. Todo lo que haya fallado se guarda en **Problemas de conexión** (con un número detrás).

Selecciona la fila que falló, pulsa **Copiar informe** y pégalo en tu comentario. Si el problema es al unirse, es lo más útil que puedes adjuntar: ya incluye el paso que falla, los tiempos, el diagnóstico del propio anfitrión y las rutas de los archivos de registro que se describen más abajo.

### 3. Los archivos de registro

Hay dos tipos, y cuál importa depende del problema.

**El registro principal del juego**, en el ordenador anfitrión:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**El registro de cada jugador.** Cada jugador que se une tiene su propia copia del juego ejecutándose en segundo plano en el ordenador anfitrión, y cada una guarda su propio registro. **Si un jugador se quedó atascado al unirse, este es el archivo que explica por qué**; el registro principal de arriba normalmente no lo explica.

Los jugadores se numeran a partir del 2, así que la primera persona que se une a tu partida es **`slot-2`**. En Linux, el registro de ese jugador está en:

`~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`

(Sí, `SlayTheSpire2` aparece de verdad dos veces; no es una errata). En Windows y macOS la estructura es la misma, dentro de la carpeta de la lista de arriba. En algunas configuraciones, en cambio, es un único archivo en `couch-coop/seat-logs/slot-2.log`. En cualquier caso, **el informe del paso 2 indica la ruta exacta**, así que copiarlo primero te ahorra tener que buscarla.

**Qué líneas importan.** En cualquiera de los dos archivos, las útiles contienen `[couchcoop]` (tienen este aspecto: `[INFO] [couchcoop] ...`), además de cualquier línea `[ERROR]`, aunque no mencione couchcoop. Normalmente esas líneas bastan por sí solas.

**Antes de pegar un registro entero:** la discusión de Steam es pública, y un registro contiene tu propio **SteamID64** (un número largo que empieza por 7656 y que lleva a tu perfil de Steam) y el **nombre de usuario** de tu ordenador, en las rutas de archivo. *No* contiene contraseñas, ni tampoco las cuentas de otros jugadores: solo la tuya. Si prefieres no publicar eso, basta con usar buscar y reemplazar en esos dos datos antes de pegarlo, o publica solo las líneas `[couchcoop]` y `[ERROR]` y, si necesito más, ya te lo pediré.

### 4. Versiones y mods

- Si estás en la rama **estable** o en la rama **beta pública** del juego.
- **Qué otros mods tienes instalados.** Cada copia de jugador en segundo plano carga los mismos mods que el anfitrión, así que otro mod puede impedir que un jugador termine de unirse aunque la partida del propio anfitrión parezca ir perfectamente.
- El sistema operativo del anfitrión.
- La versión de CouchCoop, si la sabes; si no, daré por hecho que es la más reciente.

### 5. Cualquier cosa que ayude a acotarlo

- ¿Pasa siempre o solo a veces?
- ¿Le pasa a todos los jugadores o solo a uno?
- ¿Ha funcionado alguna vez, y ha cambiado algo desde entonces, como una actualización del juego o un mod nuevo?

---

## Algo que conviene saber antes de informar

Iniciar la partida de un jugador puede tardar hasta un minuto, y en un ordenador más lento se llevará casi todo ese tiempo. Es normal, no un fallo. Mientras trabaja, la página para unirse va contando y cambiando de etapa debajo de *Unirse…*; si esa línea sigue moviéndose, todavía no ha fallado nada, así que deja la página abierta.
