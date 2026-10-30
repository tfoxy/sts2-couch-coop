# ¿No puedes conectarte desde un teléfono o una tableta?

> Esta es una traducción de la discusión del Workshop de Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Para hacer una pregunta o informar de un problema, deja un comentario en esa discusión; no hace falta que escribas en inglés, puedes hacerlo en español.

Prueba estos pasos si tu teléfono o tableta no puede conectarse. Para cierres inesperados o problemas durante una partida, consulta [¿Tienes un problema? Coméntalo en la discusión de Steam](reporting-a-problem.md).

### 1. Elige los ajustes de conexión

En el ordenador donde se ejecuta el juego, abre **Código QR de Couch Co-Op**.

- **Interfaz de red** (izquierda): elige **Por cable (Ethernet)** si el ordenador está conectado al router por cable, o **Wi-Fi** si está conectado de forma inalámbrica. Elige la conexión al router que usa tu teléfono. Omite **Nombre del PC (.local)**.
- **Método de conexión** (derecha): elige **Dirección directa**, sin «(HTTPS)». La dirección debe empezar por `http://`, por ejemplo `http://192.168.1.5:13337`.

Vuelve a escanear el código QR después de cambiar estos ajustes.

Usa **Dirección directa** mientras buscas la causa del problema. Los métodos HTTPS son opciones para mejorar el rendimiento y la seguridad, con requisitos adicionales de configuración o conexión.

### 2. Comprueba la red del teléfono

- Conecta el teléfono al Wi-Fi de casa, no a la red de **invitados**. El ordenador puede usar Wi-Fi o un cable al mismo router.
- Comprueba que el teléfono usa Wi-Fi en lugar de datos móviles.
- Desconecta temporalmente cualquier VPN del teléfono o del ordenador. También cuentan los bloqueadores de anuncios del teléfono que usan una conexión VPN.

**Si la página se abre pero se queda atascada al unirse, salta al paso 6.**

### 3. Windows: permite el juego en el firewall

En tu red doméstica:

1. **Configuración > Red e Internet > Wi-Fi** (o Ethernet) > haz clic en tu red > cambia **Tipo de perfil de red** a **Red privada**.
2. **Configuración > Privacidad y seguridad > Seguridad de Windows > Firewall y protección de red > Permitir a una aplicación atravesar el firewall**
3. Busca **Slay the Spire 2** en la lista y comprueba que la casilla **Privada** esté marcada. Si no aparece en la lista, usa **Permitir otra aplicación...** y busca el `.exe` del juego.

Si antes cancelaste el aviso del firewall para el juego, elimina su entrada bloqueada y vuelve a añadir el juego.

Si tu antivirus tiene su propio firewall, permite el juego también ahí.

Abrir la dirección en el ordenador donde se ejecuta el juego no comprueba si el firewall permite que se conecte tu teléfono.

### 4. Comprueba si el navegador fuerza HTTPS

El método **Dirección directa** usa `http://`. Si el navegador intenta cambiarlo a `https://`, revisa su ajuste de conexiones seguras:

- Chrome: **Configuración > Privacidad y seguridad > Seguridad > Usar siempre conexiones seguras**
- Firefox: **Ajustes > Privacidad & Seguridad > Seguridad de la conexión y del software > Configuración avanzada > Modo solo-HTTPS**

Permite la dirección HTTP y vuelve a escanear el código QR. Mantén **Dirección directa** seleccionado en el ordenador.

### 5. Comprueba el router

El Wi-Fi de invitados suele impedir que los dispositivos se comuniquen entre sí. Usa la red principal de casa.

Si ambos dispositivos ya están en esa red, comprueba si el router tiene activado **AP isolation**, **Client isolation** o **Wireless isolation**. Estos ajustes impiden que los dispositivos se comuniquen entre sí.

Si usas un repetidor Wi-Fi, comprueba que esté en modo **punto de acceso** (access point) o **puente** (bridge), en lugar de crear una red aparte.

### 6. Si la página se abre pero tarda en unirse

Iniciar la partida de un jugador puede tardar hasta un minuto. Mantén la página abierta mientras la línea de progreso bajo **Uniéndote…** vaya cambiando de etapa.

Si aparece un error, haz una captura de pantalla o copia el texto exacto, incluida cualquier línea gris más pequeña.

Si se queda en **Uniéndote…** o **Cargando…** sin mostrar un error, incluye el último mensaje de progreso en tu comentario.

### 7. Si antes funcionaba

La dirección del ordenador puede haber cambiado al volver a conectarse a la red o al reiniciar el router. Abre la pantalla del QR y vuelve a escanear.

Si un marcador o acceso directo antiguo de la pantalla de inicio ya no funciona, sustitúyelo usando la dirección recién escaneada.

---

## ¿Sigue sin funcionar? Comenta en la discusión de Steam

En [la discusión de Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/), empieza por indicar:

- Hasta dónde llega: no aparece la página, no hay lista de jugadores, se atasca al unirse o cargar, o se desconecta durante la partida.
- Una captura de pantalla o el mensaje de error exacto.
- El sistema operativo del ordenador, el modelo del teléfono y el navegador.
- Si falla en todos los teléfonos o solo en uno.

### Copia el informe de conexión

En el ordenador, abre **Código QR de Couch Co-Op** y busca el panel **Conexiones**. Selecciona la conexión fallida en **Problemas de conexión**, elige **Copiar informe** y pega el informe en tu comentario.

Si no aparece ninguna conexión, indícalo y publica los detalles de arriba.

El informe incluye las rutas de los archivos de registro correspondientes. Si hacen falta registros, [¿Tienes un problema? Coméntalo en la discusión de Steam](reporting-a-problem.md) explica cómo encontrarlos. Antes de publicar registros, elimina tu ID de cuenta de Steam y el nombre de usuario del ordenador si prefieres mantenerlos privados.

Usa el mod en una red de confianza: cualquiera que pueda acceder a la dirección para unirse puede abrir el cliente y jugar.
