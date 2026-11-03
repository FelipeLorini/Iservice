/* Minhas Conversas: lista autenticada compartilhada pelos dois dashboards. */
document.addEventListener('DOMContentLoaded', function () {
    'use strict';
    var painel = document.getElementById('minhasConversas');
    if (!painel) return;
    var lista = document.getElementById('listaConversas');
    var estado = document.getElementById('estadoConversas');
    var total = document.getElementById('totalConversas');
    var atualizar = document.getElementById('atualizarConversas');
    var tentar = document.getElementById('tentarConversas');
    var alternar = document.getElementById('alternarConversas');
    var token = IS.token;
    var usuarioId = id(IS.usuario && IS.usuario.id);
    var tipo = painel.getAttribute('data-conversas-tipo');
    var consulta = null, numero = 0, encerrada = false, suspensa = false, carregando = false;
    var conversas = null, expandida = false;
    var limiteInicial = 3;

    function id(value) {
        return typeof value === 'string' && value.length === 24 && /^[a-f\d]{24}$/i.test(value) ? value.toLowerCase() : null;
    }
    function sessaoAtual() {
        try {
            var pessoa = JSON.parse(localStorage.getItem('usuario') || 'null');
            return !!usuarioId && IS.logado && IS.token === token &&
                id(IS.usuario && IS.usuario.id) === usuarioId && IS.usuario.tipo === tipo &&
                localStorage.getItem('token') === token && id(pessoa && pessoa.id) === usuarioId && pessoa.tipo === tipo;
        } catch (erro) { return false; }
    }
    function ocultarExpansao() {
        alternar.hidden = true;
        alternar.disabled = true;
        alternar.textContent = 'Ver todas as conversas';
        alternar.setAttribute('aria-expanded', 'false');
    }
    function limpar() {
        numero++;
        if (consulta) consulta.abort();
        consulta = null; carregando = false;
        conversas = null; expandida = false;
        ocultarExpansao();
        lista.textContent = ''; total.textContent = '';
        lista.setAttribute('aria-busy', 'false');
        tentar.hidden = true;
    }
    function encerrar() {
        encerrada = true;
        limpar();
        atualizar.disabled = true;
        estado.textContent = 'Sessão encerrada ou expirada. Entre novamente para ver suas conversas.';
    }
    function atual(versao) {
        if (!sessaoAtual()) { encerrar(); return false; }
        return !encerrada && !suspensa && versao === numero;
    }
    function vazio(icone, titulo, texto) {
        // Somente textos fixos. Dados da API sao inseridos com textContent abaixo.
        lista.innerHTML = IS.vazio(icone, titulo, texto, 'empty-sm');
    }
    function validar(dados) {
        if (!Array.isArray(dados)) throw new Error('Resposta inválida');
        var vistos = new Set();
        return dados.map(function (item) {
            var chatId = id(item && item.id);
            var outro = item && item.outro_participante;
            var destinatarioId = id(outro && outro._id);
            if (!chatId || vistos.has(chatId) || !destinatarioId || destinatarioId === usuarioId ||
                typeof outro.nome !== 'string' ||
                !Number.isSafeInteger(item.nao_lidas) || item.nao_lidas < 0 ||
                !Number.isSafeInteger(item.total_mensagens) || item.total_mensagens < item.nao_lidas ||
                (item.total_mensagens === 0 ? item.ultima_mensagem !== null : typeof item.ultima_mensagem !== 'string')) {
                throw new Error('Resposta inválida');
            }
            vistos.add(chatId);
            return { chatId: chatId, destinatarioId: destinatarioId, nome: outro.nome.trim() || 'Participante',
                previa: item.ultima_mensagem, data: item.ultima_mensagem_data, naoLidas: item.nao_lidas };
        });
    }
    function elemento(tag, classe, texto) {
        var node = document.createElement(tag);
        node.className = classe;
        if (texto !== undefined) node.textContent = texto;
        return node;
    }
    function renderizar(itens, versao) {
        lista.textContent = '';
        total.textContent = itens.length + (itens.length === 1 ? ' conversa' : ' conversas');
        if (itens.length <= limiteInicial) expandida = false;
        alternar.hidden = itens.length <= limiteInicial;
        alternar.disabled = itens.length <= limiteInicial;
        alternar.textContent = expandida ? 'Mostrar menos' : 'Ver todas as conversas';
        alternar.setAttribute('aria-expanded', String(expandida));
        if (!itens.length) {
            vazio('fa-comments', 'Nenhuma conversa ainda', tipo === 'prestador'
                ? 'Quando um cliente iniciar uma conversa, ela aparecerá aqui.'
                : 'Suas conversas com os profissionais aparecerão aqui.');
        }
        // Preserva a ordem por atividade recebida da API, inclusive em empates.
        var visiveis = expandida ? itens : itens.slice(0, limiteInicial);
        visiveis.forEach(function (item) {
            var botao = elemento('button', 'link-row list-row conversa-item');
            botao.type = 'button';
            botao.setAttribute('aria-label', 'Abrir conversa com ' + item.nome + (item.naoLidas ? ', ' + item.naoLidas + (item.naoLidas === 1 ? ' mensagem não lida' : ' mensagens não lidas') : ''));
            var avatar = elemento('span', 'avatar avatar-sm', IS.inicial(item.nome));
            avatar.setAttribute('aria-hidden', 'true');
            var info = elemento('span', 'conversa-info');
            info.appendChild(elemento('span', 'row-title', item.nome));
            var previa = item.previa === null ? 'Ainda não há mensagens.' : item.previa;
            info.appendChild(elemento('span', 'row-sub', previa.length > 160 ? previa.slice(0, 160) + '…' : previa));
            var meta = elemento('span', 'conversa-meta');
            if (typeof item.data === 'string' && Number.isFinite(Date.parse(item.data))) {
                var data = elemento('time', 'muted', IS.tempoRelativo(item.data));
                data.dateTime = item.data;
                meta.appendChild(data);
            }
            if (item.naoLidas) meta.appendChild(elemento('span', 'badge badge--success', String(item.naoLidas)));
            botao.appendChild(avatar); botao.appendChild(info); botao.appendChild(meta);
            botao.addEventListener('click', function () {
                if (atual(versao) && !carregando) IS.chat.abrirExistente(item.chatId, item.destinatarioId);
            });
            lista.appendChild(botao);
        });
        estado.textContent = itens.length > limiteInicial
            ? 'Mostrando ' + visiveis.length + ' de ' + itens.length + ' conversas.'
            : itens.length ? 'Conversas atualizadas.' : '';
    }
    async function carregar() {
        if (!sessaoAtual()) { encerrar(); return; }
        if (encerrada || suspensa) return;
        if (consulta) consulta.abort();
        var versao = ++numero;
        var controller = new AbortController(); consulta = controller;
        carregando = true; atualizar.disabled = true; tentar.hidden = true;
        conversas = null;
        ocultarExpansao();
        lista.textContent = ''; total.textContent = '';
        lista.setAttribute('aria-busy', 'true');
        vazio('fa-spinner fa-spin', 'Carregando conversas…', '');
        estado.textContent = 'Carregando conversas…';
        try {
            var resposta = await fetch(IS.API_URL + '/chat', {
                method: 'GET', cache: 'no-store', signal: controller.signal,
                headers: { Authorization: 'Bearer ' + token }
            });
            if (!atual(versao)) return;
            if (resposta.status === 401) { encerrar(); IS.sair(); return; }
            if (!resposta.ok) throw new Error('Falha ao carregar');
            var dados = await resposta.json();
            if (!atual(versao)) return;
            conversas = validar(dados);
            renderizar(conversas, versao);
        } catch (erro) {
            if (!atual(versao) || erro.name === 'AbortError') return;
            conversas = null; expandida = false;
            ocultarExpansao();
            lista.textContent = ''; total.textContent = '';
            vazio('fa-triangle-exclamation', 'Não foi possível carregar suas conversas', 'Tente novamente.');
            estado.textContent = 'Falha ao carregar conversas. Verifique sua conexão e tente novamente.';
            tentar.hidden = false;
        } finally {
            if (atual(versao)) {
                consulta = null; carregando = false; atualizar.disabled = false;
                lista.setAttribute('aria-busy', 'false');
            }
        }
    }
    atualizar.addEventListener('click', carregar);
    tentar.addEventListener('click', carregar);
    alternar.addEventListener('click', function () {
        if (!atual(numero) || carregando || !conversas || conversas.length <= limiteInicial) return;
        expandida = !expandida;
        renderizar(conversas, numero);
    });
    IS.aoMudarSessao(function () { if (!sessaoAtual()) encerrar(); });
    window.addEventListener('storage', function (event) {
        if ((event.key === null || event.key === 'token' || event.key === 'usuario') && !sessaoAtual()) encerrar();
    });
    window.addEventListener('pagehide', function () {
        suspensa = true; limpar(); atualizar.disabled = true; estado.textContent = '';
    });
    window.addEventListener('pageshow', function (event) {
        if (event.persisted) { suspensa = false; carregar(); }
    });
    window.addEventListener('focus', function () { if (!carregando) carregar(); });
    if (IS.exigirSessao(tipo)) carregar();
    else encerrar();
});
