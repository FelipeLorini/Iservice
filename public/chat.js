/* Fluxo de chat compartilhado pelos catalogos, favoritos e Dashboard. */
(function () {
    'use strict';
    var abertura = null;
    var sequencia = 0;
    var encerrarTela = null;
    var temTela = false;
    var ID = /^[a-f\d]{24}$/i;
    var tokenInicial = IS.token;
    var usuarioInicial = id(IS.usuario && IS.usuario.id);
    function id(value) { return typeof value === 'string' && value.length === 24 && ID.test(value) ? value.toLowerCase() : null; }
    function ref(value) { return id(typeof value === 'string' ? value : value && value._id); }
    function sessaoAtual(token, usuarioId) {
        try {
            var salvo = JSON.parse(localStorage.getItem('usuario') || 'null');
            return IS.token === token && id(IS.usuario && IS.usuario.id) === usuarioId &&
                localStorage.getItem('token') === token && id(salvo && salvo.id) === usuarioId;
        } catch (erro) { return false; }
    }
    function participantes(chat, usuarioId, destinatarioId) {
        if (!chat || !Array.isArray(chat.participants) || chat.participants.length !== 2) return null;
        var ids = chat.participants.map(ref);
        if (!ids[0] || !ids[1] || ids[0] === ids[1] || !ids.includes(usuarioId)) return null;
        var outro = ids.find(function (p) { return p !== usuarioId; });
        return destinatarioId && outro !== destinatarioId ? null : ids;
    }
    function mensagemValida(message, ids) {
        return message && ref(message.sender) !== ref(message.receiver) &&
            ids.includes(ref(message.sender)) && ids.includes(ref(message.receiver)) && typeof message.content === 'string';
    }
    function invalidar() {
        sequencia++;
        if (abertura) abertura.controller.abort();
        abertura = null;
        if (encerrarTela) encerrarTela();
    }
    IS.aoMudarSessao(invalidar);
    window.addEventListener('storage', function (event) {
        if ((event.key === null || event.key === 'token' || event.key === 'usuario') &&
            !sessaoAtual(tokenInicial, usuarioInicial)) invalidar();
    });
    window.addEventListener('pagehide', invalidar);
    window.addEventListener('pageshow', function (event) {
        if (event.persisted && temTela && IS.logado) montar();
    });

    function navegar(chatId, destinatarioId, usuarioId) {
        window.location.href = 'chat.html?chatId=' + chatId + '&destinatarioId=' + destinatarioId + '&usuarioId=' + usuarioId;
    }

    // A lista autenticada ja fornece o chat: nao chamar /start nem criar outro.
    // chat.html ainda confirma a participacao e o par com o backend antes de exibir mensagens.
    function abrirExistente(chat, destinatario) {
        var usuarioId = id(IS.usuario && IS.usuario.id);
        if (!usuarioId || !IS.logado || !sessaoAtual(IS.token, usuarioId)) return false;
        var chatId = id(chat), destinatarioId = id(destinatario);
        if (!chatId || !destinatarioId || destinatarioId === usuarioId) {
            IS.toast('Conversa indisponível. Atualize sua lista e tente novamente.', 'error');
            return false;
        }
        invalidar();
        navegar(chatId, destinatarioId, usuarioId);
        return true;
    }

    function abrir(destinatario) {
        var token = IS.token;
        var usuarioId = id(IS.usuario && IS.usuario.id);
        var destinatarioId = id(destinatario);
        if (!usuarioId || !sessaoAtual(token, usuarioId)) return Promise.resolve();
        if (!destinatarioId || destinatarioId === usuarioId) {
            // Uma selecao invalida tambem cancela a navegacao pendente.
            sequencia++;
            if (abertura) abertura.controller.abort();
            abertura = null;
            IS.toast(destinatarioId === usuarioId ? 'Você não pode conversar consigo mesmo.' : 'Destinatário não identificado.', 'error');
            return Promise.resolve();
        }
        if (abertura && abertura.destinatario === destinatarioId) return abertura.promise;
        if (abertura) abertura.controller.abort();
        var numero = ++sequencia;
        var controller = new AbortController();
        var promise = (async function () {
            try {
                var resposta = await fetch(IS.API_URL + '/chat/start', {
                    method: 'POST', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                    body: JSON.stringify({ prestador_id: destinatarioId })
                });
                var dados = await resposta.json();
                if (numero !== sequencia || !sessaoAtual(token, usuarioId)) return;
                if (!resposta.ok) throw new Error(dados.mensagem || 'Erro ao iniciar conversa.');
                var chatId = id(dados.chat && dados.chat._id);
                if (!chatId || !participantes(dados.chat, usuarioId, destinatarioId)) throw new Error('A conversa retornada não corresponde ao profissional selecionado.');
                navegar(chatId, destinatarioId, usuarioId);
            } catch (erro) {
                if (numero === sequencia && sessaoAtual(token, usuarioId) && erro.name !== 'AbortError') IS.toast(erro.message || 'Erro ao conectar com o servidor.', 'error');
            } finally {
                if (numero === sequencia) abertura = null;
            }
        })();
        abertura = { destinatario: destinatarioId, controller: controller, promise: promise };
        return promise;
    }

    function montar() {
        if (encerrarTela) encerrarTela();
        temTela = true;
        var token = IS.token;
        var usuarioId = id(IS.usuario && IS.usuario.id);
        var params = new URLSearchParams(window.location.search);
        var chatId = id(params.get('chatId'));
        var esperado = params.has('destinatarioId') ? id(params.get('destinatarioId')) : null;
        var dono = params.has('usuarioId') ? id(params.get('usuarioId')) : usuarioId;
        var container = document.getElementById('chatMessages');
        var input = document.getElementById('mensagemInput');
        var button = document.getElementById('btnEnviar');
        var nome = document.getElementById('chatNome');
        var avatar = document.getElementById('chatAvatar');
        var form = document.getElementById('formMensagem');
        var encerrada = false, confirmada = false, enviando = false, leitura = 0, timer;
        var consulta = null, envio = null;
        var buttonOriginal = button.innerHTML;
        function controles() { input.disabled = !confirmada || encerrada || enviando; button.disabled = !confirmada || encerrada || enviando; }
        function limpar() { nome.textContent = 'Conversa'; avatar.textContent = '?'; input.value = ''; container.innerHTML = ''; }
        function atual() {
            if (encerrada) return false;
            if (!sessaoAtual(token, usuarioId)) { parar(); return false; }
            return true;
        }
        function parar() {
            encerrada = true; confirmada = false; leitura++;
            if (consulta) consulta.abort();
            if (envio) envio.abort();
            clearInterval(timer);
            form.removeEventListener('submit', submit);
            limpar(); controles();
        }
        encerrarTela = parar;
        limpar(); controles();
        if (!chatId || !usuarioId || dono !== usuarioId ||
            (params.has('destinatarioId') && (!esperado || esperado === usuarioId))) {
            container.innerHTML = IS.vazio('fa-triangle-exclamation', 'Conversa não identificada para esta conta', 'Abra novamente pelo profissional desejado.', 'is-error');
            return;
        }
        async function carregar() {
            if (!atual()) return;
            var numero = ++leitura;
            if (consulta) consulta.abort();
            consulta = new AbortController();
            var signal = consulta.signal;
            try {
                var resposta = await fetch(IS.API_URL + '/chat/' + chatId, {
                    headers: { Authorization: 'Bearer ' + token }, signal: signal, cache: 'no-store'
                });
                var dados = await resposta.json();
                if (!atual() || numero !== leitura) return;
                if (!resposta.ok) throw new Error(dados.mensagem || 'Erro ao carregar mensagens.');
                var ids = participantes(dados.chat, usuarioId, esperado);
                if (!ids || id(dados.chat.id) !== chatId || !Array.isArray(dados.messages) ||
                    !dados.messages.every(function (m) { return mensagemValida(m, ids); })) throw new Error('A conversa recebida não corresponde aos participantes esperados.');
                esperado = ids.find(function (p) { return p !== usuarioId; });
                var outro = dados.chat.participants.find(function (p) { return ref(p) === esperado; });
                nome.textContent = outro.nome || 'Participante';
                avatar.textContent = IS.inicial(outro.nome || 'P');
                container.innerHTML = dados.messages.length ? dados.messages.map(function (m) {
                    var hora = new Date(m.createdAt || m.data_envio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    return '<div class="mensagem ' + (ref(m.sender) === usuarioId ? 'enviada' : 'recebida') + '">' +
                        IS.esc(m.content) + '<span class="hora">' + IS.esc(hora) + '</span></div>';
                }).join('') : IS.vazio('fa-comment-dots', 'Nenhuma mensagem ainda', 'Envie uma mensagem para iniciar a conversa.', 'sem-mensagens');
                container.scrollTop = container.scrollHeight;
                confirmada = true; controles();
                if (dados.messages.some(function (m) { return ref(m.receiver) === usuarioId && !m.read; })) {
                    // Repetido no proximo polling se a marcacao falhar temporariamente.
                    await fetch(IS.API_URL + '/chat/' + chatId + '/read', { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, signal: signal });
                    atual();
                }
            } catch (erro) {
                if (!atual() || numero !== leitura || erro.name === 'AbortError') return;
                confirmada = false; controles(); nome.textContent = 'Conversa'; avatar.textContent = '?';
                container.innerHTML = IS.vazio('fa-triangle-exclamation', 'Erro ao carregar mensagens', erro.message || 'Tente novamente.', 'is-error');
            }
        }
        async function enviar() {
            var content = input.value.trim();
            if (!atual() || !confirmada || enviando || !content) return;
            enviando = true; controles();
            button.innerHTML = '<span>Enviando...</span>';
            envio = new AbortController();
            try {
                var resposta = await fetch(IS.API_URL + '/chat/message', {
                    method: 'POST', signal: envio.signal,
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                    body: JSON.stringify({ chat_id: chatId, content: content })
                });
                var dados = await resposta.json();
                if (!atual()) return;
                if (!resposta.ok) throw new Error(dados.mensagem || 'Erro ao enviar mensagem.');
                if (!mensagemValida(dados.message, [usuarioId, esperado]) || ref(dados.message.sender) !== usuarioId) throw new Error('Resposta de envio inconsistente.');
                input.value = '';
                await carregar();
            } catch (erro) {
                if (atual() && erro.name !== 'AbortError') IS.toast(erro.message || 'Erro ao conectar com o servidor.', 'error');
            } finally {
                if (atual()) { enviando = false; button.innerHTML = buttonOriginal; controles(); input.focus(); }
            }
        }
        function submit(event) { event.preventDefault(); enviar(); }
        form.addEventListener('submit', submit);
        carregar();
        timer = setInterval(carregar, 5000);
    }
    IS.chat = { abrir: abrir, abrirExistente: abrirExistente, montar: montar };
})();
