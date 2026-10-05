# Não consegue se conectar pelo celular ou tablet?

> Esta é uma tradução da discussão da Oficina Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Para fazer uma pergunta ou relatar um problema, deixe um comentário nessa discussão — não precisa escrever em inglês, pode escrever em português.

A maioria dos problemas de conexão se resume a um punhado de causas. Esta lista está ordenada, mais ou menos, da mais comum para a menos comum, então vale a pena seguir na ordem.

*Se o seu celular chega à página de entrada sem problemas e o problema é outro — um crash, um jogador que nunca termina de entrar, algo errado no próprio jogo —, veja [Está com algum problema? Poste na discussão da Steam](reporting-a-problem.md).*

---

## O que tentar

### 1. Escolha outro endereço na tela do QR

A tela do QR tem um seletor com várias formas de chegar ao host. Se a que você escaneou não funcionar, escolha outra e escaneie de novo.

Dê preferência ao endereço numérico simples (algo como **192.168.1.5:13337**). É o que tem menos peças que podem falhar. O nome **.local** e o link da web dependem de coisas fora do mod — o seu roteador, uma conexão com a internet, permissões do navegador —, então podem falhar numa rede em que o endereço numérico funciona perfeitamente.

**No iPhone ou iPad, ignore completamente a opção *Link da web*.** O Safari — e todos os outros navegadores do iOS, porque por baixo todos são o Safari — não deixa uma página carregada da internet acessar nada da sua rede de casa. É uma regra do navegador, não uma configuração, então não há nada para permitir nem nada para mudar: a página vai carregar e depois dizer que o jogo não respondeu, em qualquer rede, seja qual for a configuração do seu firewall. No iPhone ou iPad, use **Endereço simples** ou **Link seguro**. (Agora a própria página avisa isso, se você chegar até lá.)

### 2. Confira se o celular está mesmo na mesma rede

- No mesmo Wi-Fi que o computador do host, e não na rede de **convidados**. Redes de convidados costumam impedir que os dispositivos se comuniquem entre si, que é exatamente o que é preciso aqui.
- Sem usar dados móveis. Se o Wi-Fi não tiver acesso à internet, às vezes o celular muda sozinho para os dados móveis sem avisar.
- **Desligue qualquer VPN no celular.** Isso pega muita gente. Bloqueadores de anúncios e apps de "DNS particular" que funcionam como VPN também contam.

### 3. Leia o que a página diz enquanto está entrando

Iniciar o jogo de um jogador pode levar até um minuto, e isso é normal, não um defeito. Enquanto isso acontece, a página agora mostra em que ponto está, numa linha abaixo de *Entrando…*:

*Conectando ao anfitrião — etapa 1 de 6, 14 s até agora. Isso pode levar até um minuto, então mantenha esta página aberta.*

Se essa linha estiver contando e mudando de etapa, está funcionando — mantenha a página aberta. As seis etapas são: conectando ao anfitrião, aguardando o anfitrião, iniciando o jogo deste jogador, conectando este jogador ao jogo, carregando a tela do jogo e quase pronto.

### 4. Se parar, copie o que a página mostrar

A página de entrada e a tela de jogo de cada jogador usam a mesma porta do navegador no computador anfitrião (**13337** por padrão). Abrir outras portas para o navegador não resolve uma falha ao entrar.

Se aparecer um erro durante *Entrando…* ou *Carregando…*, inclua no relato o texto exato e a linha técnica cinza, se houver. O anfitrião também pode abrir o painel **Conexões** na tela do QR para ver em qual etapa houve a falha. Se a página nem abrir, confira as orientações de rede e firewall nas seções 2, 5 e 6.

Se a página ficar em *Entrando…* ou *Carregando…* sem mostrar um erro, diga em qual tela parou e qual foi a última linha de progresso. Mantenha a página aberta enquanto a etapa de progresso estiver mudando.

### 5. Windows: libere o jogo no firewall

Primeiro verifique o tipo de rede, porque só isso já bloqueia muitas conexões:

- **Configurações > Rede e Internet > Wi-Fi** (ou Ethernet) > clique na sua rede > defina **Tipo de perfil de rede** como **Rede privada**.

Depois, libere o jogo:

- **Configurações > Privacidade e segurança > Segurança do Windows > Firewall e proteção de rede > Permitir um aplicativo pelo firewall**
- Encontre **Slay the Spire 2** na lista e confira se **Privada** está marcada. Se ele não estiver na lista, use **Permitir outro aplicativo...** e procure o `.exe` do jogo.

Se em algum momento você respondeu "Cancelar" a um aviso do firewall do Windows, o Windows guarda isso como uma regra de bloqueio e nunca mais vai perguntar. Nesse caso, você precisa remover a entrada acima e adicioná-la de novo.

**Abrir o endereço num navegador no próprio PC do host não prova nada.** É a primeira coisa que dá vontade de testar, e já foi medido que isso engana: o Windows não filtra o tráfego de um computador para ele mesmo — nem mesmo para o seu próprio endereço de rede —, então, com o firewall bloqueando ativamente todos os celulares, o navegador do próprio host ainda carrega a página perfeitamente. Se isso funcionou para você, significa que o jogo está rodando e servindo a página. Não diz absolutamente nada sobre o firewall.

Só marque **Pública** se a sua rede estiver definida como pública e você não puder mudar isso. Marcar essa opção deixa o jogo acessível em qualquer rede em que você entrar, incluindo cafés e hotéis.

### 6. O roteador

Alguns roteadores impedem que dispositivos no mesmo Wi-Fi se comuniquem entre si. Procure uma configuração chamada **AP isolation**, **Client isolation** ou **Wireless isolation** (em português, "isolamento AP" ou "isolação de clientes") e desative-a.

Também vale saber: um repetidor de Wi-Fi ou adaptador powerline configurado no modo **router** (roteador) em vez do modo **bridge** / **access point** (ponte / ponto de acesso) coloca o seu celular numa rede separada da do host, mesmo que o nome do Wi-Fi pareça o mesmo.

### 7. Configurações do navegador que bloqueiam endereços simples

Alguns navegadores tentam forçar HTTPS em todos os endereços, e o endereço numérico simples não usa HTTPS. (A opção **Link seguro** da tela do QR é a que usa — então, se o problema for o HTTPS forçado, também vale a pena testar essa opção.) Se a barra de endereço mostrar um aviso de segurança em vez do jogo, desative estas opções e tente de novo:

- Chrome: **Configurações > Privacidade e segurança > Segurança > Sempre usar conexões seguras**
- Firefox: **Configurações > Privacidade e Segurança > Conexão e segurança de software > Configurações avançadas > Modo somente HTTPS**

No iPhone, confira também **Ajustes > *seu nome* > iCloud > Retransmissão Privada** e a opção "Ocultar Endereço IP" em **Ajustes > Apps > Safari**.

### 8. Antivírus com firewall próprio

Pacotes de segurança como ESET, Bitdefender, Norton, Kaspersky e Avast têm o seu próprio firewall, separado do Windows. Liberar o jogo no Windows não adianta nada para eles. Confira as configurações de rede ou de firewall do próprio antivírus, ou pause o firewall dele por um instante para ver se é isso que está bloqueando.

### 9. Se funcionava e parou de funcionar

O endereço do computador do host pode mudar quando ele se reconecta ao Wi-Fi ou depois que o roteador é reiniciado. Abra a tela do QR de novo e escaneie outra vez — o novo endereço vai estar lá.

Se você adicionou o cliente à tela de início, o que acontece depois depende da opção pela qual você o instalou:

- Instalado pela opção **Link da web**: continua funcionando e encontra o novo endereço sozinho. É só abrir — não precisa escanear de novo.
- Instalado pelo **endereço numérico** ou pelo **Link seguro**: o ícone aponta para o endereço antigo e não tem como se recuperar. Apague-o e adicione de novo depois de escanear outra vez. (No Android, instalar pela opção **Link da web** evita isso de vez. No iPhone ou iPad essa opção não funciona — veja a seção 1 —, então adicionar o ícone de novo é a única saída.)

---

## Ainda não deu certo? Comente na discussão da Steam

Deixe um comentário na [discussão da Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) — não precisa responder tudo. Mesmo uma ou duas destas informações já deixam o relato muito mais fácil de resolver, e a primeira pergunta vale mais do que todas as outras juntas.

### Até onde chega?

Essa é a coisa mais útil que você pode me contar, porque cada resposta aponta para uma causa diferente:

- o navegador nunca carrega nada
- a página carrega, mas a lista de jogadores nunca aparece
- dá para escolher um nome, mas fica parado em “Entrando…” — me diga o que a linha de progresso abaixo dizia e qual mensagem apareceu, se você esperou
- passa dessa etapa e fica em “**Carregando…**” — diga se aparece algum erro e copie o texto exato e a linha técnica cinza
- conectou normalmente e depois caiu durante a partida

### Qualquer outra coisa que você puder acrescentar

- A mensagem exata que o celular mostra, incluindo a linha cinza abaixo dela. Uma foto da tela é perfeita.
- Qual endereço você escaneou — o numérico, o nome **.local** ou o link da web.
- O sistema operacional do host, e o modelo e o navegador do celular/tablet.
- Falha em **todos** os dispositivos ou só em um? Se um celular funciona e outro não, isso já descarta muita coisa.
- Já funcionou antes? Mudou alguma coisa desde então?
- Se o host está no Wi-Fi ou no cabo (Ethernet). Se há alguma VPN rodando no host ou no celular. Se há algum antivírus com firewall.

### Três coisas que o computador do host pode te dar

- **O painel de conexões.** No host, abra a tela **Código QR do Couch Co-Op** — o painel **Conexões** fica nela, abaixo do código. Os dispositivos que chegaram longe o bastante para aparecer ali ficam listados, e tudo o que deu errado fica guardado em **Problemas de conexão** (com um número depois). Selecione a linha e use **Copiar relatório** — isso copia um relatório que já inclui a etapa que falhou, os tempos e o diagnóstico do próprio host. Cole direto no seu comentário. Ele também informa o caminho exato dos dois arquivos de log abaixo, o que poupa você de ter que procurá-los.
- **O arquivo de log principal.** No Windows, `%APPDATA%\SlayTheSpire2\logs\godot.log`. No Linux, `~/.local/share/SlayTheSpire2/logs/godot.log`. No macOS, `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **O log de cada jogador.** Cada jogador que entra ganha a sua própria cópia do jogo rodando em segundo plano no host, e cada uma mantém o seu próprio log. **Se a entrada chegou a *Entrando…* e depois o tempo esgotou, este é o arquivo que explica o motivo** — o log principal acima normalmente não explica. Os jogadores são numerados a partir de 2, então a primeira pessoa que entra é **`slot-2`**: no Linux, é `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` (sim, `SlayTheSpire2` duas vezes — não é erro de digitação), e os caminhos do Windows e do macOS seguem o mesmo formato dentro das pastas acima. Em algumas configurações, em vez disso, é um único arquivo em `couch-coop/seat-logs/slot-2.log`.

**Quais linhas importam.** Em qualquer um dos logs, as úteis contêm `[couchcoop]` — elas têm esta cara: `[INFO] [couchcoop] ...` —, além de qualquer linha `[ERROR]`, mesmo as que não mencionam couchcoop. Normalmente elas bastam sozinhas.

**Antes de colar um log inteiro:** a discussão da Steam é pública, e um log contém o seu próprio **SteamID64** (um número longo que começa com 7656 e leva ao seu perfil da Steam) e o **nome de usuário** do seu computador, nos caminhos de arquivo. Ele *não* contém senhas, e não contém as contas de outros jogadores — só a sua. Se preferir não publicar isso, basta usar localizar e substituir nesses dois dados antes de colar, ou publique só as linhas `[couchcoop]` e `[ERROR]`, e eu peço mais se precisar.

---

Um último aviso: qualquer pessoa que consiga acessar o endereço de entrada pode abrir o cliente e jogar, então use isto numa rede em que você confia.
