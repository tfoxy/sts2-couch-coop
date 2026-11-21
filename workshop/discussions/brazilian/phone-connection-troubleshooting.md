# Não consegue se conectar pelo celular ou tablet?

> Esta é uma tradução da discussão da Oficina Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Para fazer uma pergunta ou relatar um problema, deixe um comentário nessa discussão — não precisa escrever em inglês, pode escrever em português.

Tente estes passos se o celular ou tablet não conseguir se conectar. Para travamentos ou problemas durante uma partida, veja [Está com um problema? Comente na discussão do Steam](reporting-a-problem.md).

### 1. Escolha as configurações de conexão

No computador que está rodando o jogo, abra **Código QR do Couch Co-Op**.

- **Interface de rede** (à esquerda): escolha **Com fio (Ethernet)** se o computador estiver conectado ao roteador por cabo, ou **Wi-Fi** se estiver conectado sem fio. Se o computador tiver as duas conexões, escolha a que estiver conectada ao mesmo roteador do celular. Ignore **Nome do PC (.local)**.
- **Método de conexão** (à direita): escolha **Endereço direto**, sem “(HTTPS)”. O endereço deve começar com `http://`, por exemplo `http://192.168.1.5:13337`.

Escaneie o código QR de novo depois de alterar essas configurações.

Use **Endereço direto** enquanto tenta resolver o problema. Os métodos HTTPS podem ser mais rápidos e seguros, mas precisam de configuração extra. Deixe para usá-los depois que o endereço simples funcionar.

### 2. Confira a rede do celular

- Conecte o celular ao Wi-Fi de casa, não à rede de **convidados**. O computador pode usar Wi-Fi ou um cabo conectado ao mesmo roteador.
- Confira se o celular está usando Wi-Fi em vez de dados móveis.
- Desconecte temporariamente qualquer VPN no celular ou computador. Isso inclui bloqueadores de anúncios do celular que usam uma conexão VPN.

**Se a página abrir, mas travar ao entrar na partida, pule para o passo 6.**

### 3. Windows: libere o jogo no firewall

1. **Configurações > Rede e Internet > Wi-Fi** (ou Ethernet) > clique na sua rede > defina **Tipo de perfil de rede** como **Rede privada**.
2. **Configurações > Privacidade e segurança > Segurança do Windows > Firewall e proteção de rede > Permitir um aplicativo pelo firewall**
3. Encontre **Slay the Spire 2** na lista e confira se **Privada** está marcada. Se ele não estiver na lista, use **Permitir outro aplicativo...** e procure o `.exe` do jogo.

Se você cancelou o aviso do firewall para o jogo antes, remova a entrada bloqueada e adicione o jogo de novo.

Se o antivírus tiver seu próprio firewall, libere o jogo nele também.

Se a página abrir no próprio computador, isso não significa que o firewall deixa o celular se conectar.

### 4. Confira se o navegador está forçando HTTPS

O método **Endereço direto** usa `http://`. Se o navegador tentar mudar para `https://`, confira a configuração de conexões seguras:

- Chrome: **Configurações > Privacidade e segurança > Segurança > Sempre usar conexões seguras**
- Firefox: **Configurações > Privacidade e Segurança > Conexão e segurança de software > Configurações avançadas > Modo somente HTTPS**

Permita o endereço HTTP e escaneie o código QR de novo. Mantenha **Endereço direto** selecionado no computador.

### 5. Confira o roteador

Se os dois dispositivos estiverem na rede principal de casa e ainda não conseguirem se comunicar, confira se **AP isolation**, **Client isolation** ou **Wireless isolation** está ativado no roteador. Essas configurações impedem que os dispositivos se comuniquem entre si.

Se você usa um repetidor Wi-Fi, confira se ele está no modo **ponto de acesso** (access point) ou **bridge**, em vez de criar uma rede separada.

### 6. Se a página abrir, mas demorar para entrar

Iniciar a partida de um jogador pode levar até um minuto. Mantenha a página aberta enquanto a linha de progresso abaixo de **Entrando…** muda de etapa.

Se aparecer um erro, tire uma captura de tela ou copie o texto exato, incluindo qualquer linha cinza menor.

Se ficar em **Entrando…** ou **Carregando…** sem erro, inclua a última mensagem de progresso no seu comentário.

### 7. Se funcionava antes

O endereço do computador pode ter mudado depois de reconectar à rede ou reiniciar o roteador. Abra a tela do QR e escaneie de novo.

Se um favorito ou atalho antigo da tela inicial não funcionar mais, substitua usando o endereço recém-escaneado.

---

## Ainda não conseguiu? Comente na discussão do Steam

Na [discussão do Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/), inclua:

- Até onde chega: não abre a página, não aparece a lista de jogadores, trava ao entrar/carregar ou desconecta durante a partida.
- Uma captura de tela ou a mensagem de erro exata.
- O sistema operacional do computador, o modelo do celular e o navegador.
- Se falha em todos os celulares ou só em um.

### Copie o relatório de conexão

No computador, abra **Código QR do Couch Co-Op** e procure **Conexões**. Selecione a conexão que falhou em **Problemas de conexão**, escolha **Copiar relatório** e cole o relatório no seu comentário.

Se nenhuma conexão aparecer ali, diga isso e publique os detalhes acima.

O relatório inclui os caminhos dos arquivos de log relevantes. Se forem necessários logs, [Está com um problema? Comente na discussão do Steam](reporting-a-problem.md) explica como encontrá-los. Antes de publicar logs, remova seu ID de conta Steam e o nome de usuário do computador se preferir mantê-los privados.

Use o mod em uma rede de confiança: qualquer pessoa que consiga acessar o endereço para entrar pode entrar na sua partida.
