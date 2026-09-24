# ¿No puedes conectarte desde un teléfono o una tableta?

> Esta es una traducción de la discusión del Workshop de Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Para hacer una pregunta o informar de un problema, deja un comentario en esa discusión; no hace falta que escribas en inglés, puedes hacerlo en español.

La mayoría de los problemas de conexión se deben a un puñado de causas. Esta lista está ordenada, más o menos, de la más habitual a la menos habitual, así que merece la pena seguirla en orden.

*Si tu teléfono llega bien a la página para unirse y el problema es otro (un cierre inesperado, un jugador que nunca termina de unirse, algo que falla en el propio juego), consulta [¿Tienes algún problema? Publícalo en la discusión de Steam](reporting-a-problem.md).*

---

## Qué probar

### 1. Elige otra dirección en la pantalla del QR

La pantalla del QR tiene un selector con varias formas de conectarse al anfitrión. Si la que has escaneado no funciona, elige otra y vuelve a escanear.

Es preferible la dirección numérica simple (algo como **192.168.1.5:13337**). Es la que menos piezas tiene que puedan fallar. El nombre **.local** y el enlace web dependen de cosas ajenas al mod (tu router, una conexión a internet, los permisos del navegador), así que pueden fallar en una red en la que la dirección numérica funciona perfectamente.

**En un iPhone o iPad, olvídate por completo de la opción *Enlace web*.** Safari (y cualquier otro navegador de iOS, porque por dentro todos son Safari) no permite que una página cargada desde internet acceda a nada de tu red doméstica. Es una norma del navegador, no un ajuste, así que no hay nada que permitir ni nada que cambiar: la página cargará y después te dirá que el juego no ha respondido, en cualquier red y tengas el firewall como lo tengas. En un iPhone o iPad, usa **Dirección simple** o **Enlace seguro**. (Ahora la propia página te lo advierte, si llegas hasta ahí).

### 2. Comprueba que el teléfono está de verdad en la misma red

- En la misma red Wi-Fi que el ordenador anfitrión, y no en la red de **invitados**. Las redes de invitados suelen impedir que los dispositivos se comuniquen entre sí, que es justo lo que hace falta aquí.
- Sin usar datos móviles. Si la red Wi-Fi no tiene acceso a internet, a veces los teléfonos se pasan solos a los datos móviles sin avisarte.
- **Desactiva cualquier VPN del teléfono.** Aquí es donde falla mucha gente. También cuentan los bloqueadores de anuncios y las aplicaciones de «DNS privado» que funcionan como una VPN.

### 3. Lee lo que te dice la página mientras se une

Iniciar la partida de un jugador puede tardar hasta un minuto, y eso es normal, no un fallo. Mientras tanto, la página ahora te indica por dónde va, en una línea debajo de *Uniéndote…*:

*Conectando con el anfitrión: paso 1 de 6, 14 s hasta ahora. Esto puede tardar hasta un minuto, así que deja esta página abierta.*

Si esa línea va contando y cambiando de etapa, está funcionando: deja la página abierta. Las seis etapas son: conectando con el anfitrión, esperando al anfitrión, iniciando el juego de este jugador, conectando a este jugador con la partida, cargando la vista del juego y casi listo.

### 4. Si se detiene, ahora la página te dice POR QUÉ

Cuando algo falla de verdad, a tu dispositivo le llega un aviso que indica cuál de varios problemas sin relación entre sí ha sido, en dos frases más una línea técnica en gris. **Incluye todo eso en cualquier informe.** Hay tres posibles, y cada uno necesita una solución completamente distinta:

- «**Tu juego está en marcha en el ordenador anfitrión, pero este dispositivo no ha podido conectarse a él.**»\
  Es la ruta de red entre tu teléfono y el anfitrión: una red Wi-Fi de invitados, una VPN o un router que mantiene aislados los dispositivos. La partida del anfitrión no tiene ningún problema. Consulta las secciones 2 y 6.
- «**Otro programa del ordenador anfitrión está usando el puerto que necesita tu juego.**»\
  No hay nada que cambiar en tu dispositivo. En el anfitrión, otra cosa está ocupando uno de los puertos que necesita cada jugador; casi siempre es un proceso de jugador que se ha quedado abierto de una sesión anterior. Quien haga de anfitrión debe cerrarlo (reiniciar Slay the Spire 2 lo soluciona).
- «**El ordenador anfitrión está bloqueando el puerto que usa tu juego.**»\
  Tampoco hay nada que cambiar en tu dispositivo. Lo está bloqueando el propio firewall o el software de seguridad del anfitrión; consulta la sección 5.

**El caso de bloqueo más habitual ni siquiera muestra *Uniéndote…*.** Si tu dispositivo ha llegado al anfitrión pero no puede llegar al puerto asignado a tu propio jugador, la unión *se completa*, y después la página pasa a *Cargando…* y se queda ahí. En esa pantalla no hay línea de progreso ni cuenta atrás, porque, desde el lado del anfitrión, no ha fallado nada. Lo primero útil que verás es el mensaje «**no ha podido conectarse a él**» de arriba, unos **20 segundos** después de que cambie la página. Así que, si te quedas atascado en *Cargando…*, espera medio minuto a que aparezca ese mensaje en lugar de recargar: al recargar, toda la espera vuelve a empezar.

Si, en cambio, se queda en *Uniéndote…* y no cambia nunca, el anfitrión se rinde a los 75 segundos con *No se pudo iniciar la vista del juego. Inténtalo de nuevo.* y una línea gris debajo. Es un fallo distinto del anterior. En cualquier caso, copia lo que diga.

### 5. Cada jugador usa su propio puerto

La sala está en el **13337**, y después cada jugador usa el **13357**, el **13367**, el **13377** y así sucesivamente. Una regla de firewall que solo abra el 13337 te deja llegar a la lista de jugadores y luego falla en el segundo paso. Si has añadido una (por tu cuenta o siguiendo una guía), elimínala y, en su lugar, permite **el programa del juego**: así quedan cubiertos todos los puertos que necesita.

### 6. Windows: permite el juego en el firewall

Primero comprueba el tipo de red, porque esto por sí solo bloquea muchas conexiones:

- **Configuración > Red e Internet > Wi-Fi** (o Ethernet) > haz clic en tu red > cambia **Tipo de perfil de red** a **Red privada**.

Después, permite el juego:

- **Configuración > Privacidad y seguridad > Seguridad de Windows > Firewall y protección de red > Permitir a una aplicación atravesar el firewall**
- Busca **Slay the Spire 2** en la lista y comprueba que la casilla **Privada** esté marcada. Si no aparece en la lista, usa **Permitir otra aplicación...** y busca el `.exe` del juego.

Si en algún momento respondiste «Cancelar» a un aviso del firewall de Windows, Windows lo recuerda como una regla de bloqueo y no volverá a preguntarte nunca. En ese caso, tienes que eliminar la entrada de arriba y volver a añadirla.

**Abrir la dirección en un navegador del propio PC anfitrión no demuestra nada.** Es lo primero que se le ocurre a cualquiera, y está comprobado que confunde: Windows no filtra el tráfico de un ordenador hacia sí mismo (ni siquiera hacia su propia dirección de red), así que, aunque el firewall esté bloqueando activamente todos los teléfonos, el navegador del propio anfitrión sigue cargando la página perfectamente. Si a ti te ha funcionado, eso te dice que el juego está en marcha y sirviendo la página. No dice absolutamente nada del firewall.

Marca **Pública** solo si tu red está configurada como pública y no puedes cambiarlo. Si la marcas, el juego queda accesible en cualquier red a la que te conectes, incluidas las de cafeterías y hoteles.

### 7. El router

Algunos routers impiden que los dispositivos conectados a la misma red Wi-Fi se comuniquen entre sí. Busca un ajuste llamado **AP isolation**, **Client isolation** o **Wireless isolation** (en español, «aislamiento de AP») y desactívalo.

También conviene saber que un repetidor Wi-Fi o un adaptador PLC configurado en modo **router** en lugar de en modo **bridge** / **access point** (puente / punto de acceso) pone tu teléfono en una red distinta de la del anfitrión, aunque el nombre de la red Wi-Fi parezca el mismo.

### 8. Ajustes del navegador que bloquean las direcciones simples

Algunos navegadores intentan forzar HTTPS en todas las direcciones, y la dirección numérica simple no lo usa. (La opción **Enlace seguro** de la pantalla del QR sí lo usa, así que, si el problema es que se fuerza HTTPS, también merece la pena probarla). Si la barra de direcciones muestra una advertencia de seguridad en lugar del juego, desactiva estas opciones y vuelve a intentarlo:

- Chrome: **Configuración > Privacidad y seguridad > Seguridad > Usar siempre conexiones seguras**
- Firefox: **Ajustes > Privacidad & Seguridad > Modo solo-HTTPS**

En iPhone, revisa también en **Ajustes > Apps > Safari** el Relay privado de iCloud y «Ocultar dirección IP».

### 9. Antivirus con su propio firewall

Los paquetes de seguridad como ESET, Bitdefender, Norton, Kaspersky y Avast tienen su propio firewall, independiente del de Windows. Permitir el juego en Windows no sirve de nada frente a ellos. Revisa los ajustes de red o de firewall del propio antivirus, o pausa su firewall un momento para ver si es eso lo que lo está bloqueando.

### 10. Si antes funcionaba y ha dejado de hacerlo

La dirección del ordenador anfitrión puede cambiar cuando vuelve a conectarse a la red Wi-Fi o después de reiniciar el router. Abre de nuevo la pantalla del QR y vuelve a escanear: ahí estará la nueva dirección.

Si añadiste el cliente a la pantalla de inicio, lo que pase a continuación depende de la opción desde la que lo instalaste:

- Instalado desde la opción **Enlace web**: sigue funcionando y encuentra la nueva dirección por sí solo. Solo tienes que abrirlo, sin volver a escanear.
- Instalado desde la **dirección numérica** o desde **Enlace seguro**: el icono apunta a la dirección antigua y no puede recuperarse. Bórralo y vuelve a añadirlo después de escanear de nuevo. (En Android, instalarlo desde la opción **Enlace web** evita esto para siempre. En un iPhone o iPad esa opción no puede funcionar, como se explica en la sección 1, así que volver a añadir el icono es la única solución).

---

## ¿Sigue sin funcionar? Comenta en la discusión de Steam

Deja un comentario en [la discusión de Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/); no hace falta que respondas a todo. Con solo una o dos de estas respuestas, el informe ya es mucho más fácil de resolver, y la primera pregunta vale más que todas las demás juntas.

### ¿Hasta dónde llega?

Es lo más útil que puedes decirme, porque cada respuesta apunta a una causa distinta:

- el navegador no llega a cargar nada
- la página carga, pero la lista de jugadores no aparece nunca
- puedes elegir un nombre, pero se queda en «Uniéndote…»: dime qué decía la línea de progreso de debajo y qué mensaje te salió si esperaste
- pasa de ahí y se queda en «**Cargando…**»: este es el caso del puerto o del firewall, y es el más habitual. Dime si apareció el mensaje «no ha podido conectarse a él» al cabo de unos 20 segundos
- se conectó bien y luego se desconectó durante la partida

### Cualquier otra cosa que puedas añadir

- El mensaje exacto que muestra el teléfono, incluida la línea gris de debajo. Una foto de la pantalla es perfecta.
- Qué dirección escaneaste: la numérica, el nombre **.local** o el enlace web.
- El sistema operativo del anfitrión, y el modelo y el navegador del teléfono o la tableta.
- ¿Falla en **todos** los dispositivos o solo en uno? Si un teléfono funciona y otro no, eso descarta muchas cosas.
- ¿Ha funcionado alguna vez, y ha cambiado algo desde entonces?
- Si el anfitrión está conectado por Wi-Fi o por Ethernet. Si hay alguna VPN activa en el anfitrión o en el teléfono. Si hay algún antivirus con firewall.

### Tres cosas que te puede dar el ordenador anfitrión

- **El panel de conexiones.** En el anfitrión, abre la pantalla **Código QR de Couch Co-Op**: el panel **Conexiones** está en ella, debajo del código. Ahí aparecen los dispositivos que llegaron lo bastante lejos, y todo lo que haya fallado se guarda en **Problemas de conexión** (con un número detrás). Selecciona la fila y usa **Copiar informe**: así se copia un informe que ya incluye el paso que falla, los tiempos y el diagnóstico del propio anfitrión. Pégalo directamente en tu comentario. También indica la ruta exacta de los dos archivos de registro de abajo, lo que te ahorra tener que buscarlos.
- **El archivo de registro principal.** En Windows, `%APPDATA%\SlayTheSpire2\logs\godot.log`. En Linux, `~/.local/share/SlayTheSpire2/logs/godot.log`. En macOS, `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **El registro de cada jugador.** Cada jugador que se une tiene su propia copia del juego ejecutándose en segundo plano en el anfitrión, y cada una guarda su propio registro. **Si la unión llegó a *Uniéndote…* y luego se agotó el tiempo de espera, este es el archivo que explica por qué**; el registro principal de arriba normalmente no lo explica. Los jugadores se numeran a partir del 2, así que la primera persona que se une es **`slot-2`**: en Linux, es `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` (sí, `SlayTheSpire2` dos veces; no es una errata), y las rutas de Windows y macOS siguen la misma estructura dentro de sus carpetas de arriba. En algunas configuraciones, en cambio, es un único archivo en `couch-coop/seat-logs/slot-2.log`.

**Qué líneas importan.** En cualquiera de los dos registros, las útiles contienen `[couchcoop]` (tienen este aspecto: `[INFO] [couchcoop] ...`), además de cualquier línea `[ERROR]`, aunque no mencione couchcoop. Normalmente bastan por sí solas.

**Antes de pegar un registro entero:** la discusión de Steam es pública, y un registro contiene tu propio **SteamID64** (un número largo que empieza por 7656 y que lleva a tu perfil de Steam) y el **nombre de usuario** de tu ordenador, en las rutas de archivo. *No* contiene contraseñas, ni tampoco las cuentas de otros jugadores: solo la tuya. Si prefieres no publicar eso, basta con usar buscar y reemplazar en esos dos datos antes de pegarlo, o publica solo las líneas `[couchcoop]` y `[ERROR]` y, si necesito más, ya te lo pediré.

---

Una última advertencia: cualquiera que pueda acceder a la dirección para unirse puede abrir el cliente y jugar, así que úsalo en una red de confianza.
