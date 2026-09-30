/* iService — central de notificações (sino do cabeçalho).
   Usa as rotas existentes da API:
     GET  /api/notificacoes            lista (últimas 30)
     GET  /api/notificacoes/nao-lidas  contador
     PUT  /api/notificacoes/:id/lida   marca uma como lida */
(function () {
    var API_URL = 'http://localhost:3000/api';
    var token = localStorage.getItem('token');

    if (!token) return;

    var TIPOS = {
        nova_proposta: { titulo: 'Nova proposta recebida', icone: 'fa-file-invoice-dollar', classe: '' },
        proposta_aceita: { titulo: 'Proposta aceita', icone: 'fa-handshake', classe: '' },
        novo_agendamento: { titulo: 'Novo agendamento', icone: 'fa-calendar-check', classe: 'is-info' },
        cancelamento: { titulo: 'Agendamento cancelado', icone: 'fa-calendar-xmark', classe: 'is-danger' },
        avaliacao: { titulo: 'Nova avaliação', icone: 'fa-star', classe: 'is-warn' }
    };

    /* A API grava as mensagens sem acentuação; aqui só ajustamos a exibição. */
    var TEXTOS = {
        'Voce recebeu uma nova proposta para o seu pedido': 'Você recebeu uma nova proposta para o seu pedido.',
        'Sua proposta foi aceita pelo cliente': 'Sua proposta foi aceita pelo cliente. Um agendamento foi criado.',
        'Voce recebeu uma nova avaliacao': 'Um cliente avaliou o seu serviço.'
    };

    var notificacoes = [];
    var naoLidas = 0;
    var el = {};

    document.addEventListener('DOMContentLoaded', function () {
        injetarSino();
        atualizarContador();
        setInterval(atualizarContador, 30000);
    });

    function esc(valor) {
        return String(valor === null || valor === undefined ? '' : valor).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function tempo(valor) {
        if (window.IS && IS.tempoRelativo) return IS.tempoRelativo(valor);
        var d = new Date(valor);
        return isNaN(d) ? '' : d.toLocaleString('pt-BR');
    }

    function injetarSino() {
        if (document.getElementById('notifItem')) return;

        var wrap = document.getElementById('notifSlot');
        if (!wrap) {
            var ul = document.querySelector('header nav ul');
            if (!ul) return;
            wrap = document.createElement('li');
            var sair = ul.querySelector('.btn-sair');
            ul.insertBefore(wrap, sair ? sair.closest('li') : null);
        }

        wrap.id = 'notifItem';
        wrap.classList.add('notif');
        wrap.innerHTML =
            '<button type="button" class="icon-btn" id="notifBtn" aria-haspopup="true" aria-expanded="false" aria-controls="notifDropdown" aria-label="Notificações" title="Notificações">' +
                '<i class="fas fa-bell"></i>' +
                '<span class="notif-badge" id="notifBadge" aria-hidden="true">0</span>' +
            '</button>' +
            '<div class="notif-panel" id="notifDropdown" role="dialog" aria-label="Notificações">' +
                '<div class="notif-head">' +
                    '<h2>Notificações <span class="notif-count" id="notifCount" hidden></span></h2>' +
                    '<button type="button" class="link-btn" id="notifLerTodas" disabled><span class="lg">Marcar todas como lidas</span><span class="sm">Ler todas</span></button>' +
                '</div>' +
                '<div class="notif-list" id="notifLista"></div>' +
            '</div>';

        el.item = wrap;
        el.btn = document.getElementById('notifBtn');
        el.badge = document.getElementById('notifBadge');
        el.panel = document.getElementById('notifDropdown');
        el.lista = document.getElementById('notifLista');
        el.count = document.getElementById('notifCount');
        el.lerTodas = document.getElementById('notifLerTodas');

        el.btn.addEventListener('click', function (e) {
            e.stopPropagation();
            alternar(!el.panel.classList.contains('open'));
        });

        el.lerTodas.addEventListener('click', marcarTodas);

        document.addEventListener('click', function (e) {
            if (el.panel.classList.contains('open') && !el.item.contains(e.target)) alternar(false);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && el.panel.classList.contains('open')) {
                alternar(false);
                el.btn.focus();
            }
        });
    }

    function alternar(abrir) {
        el.panel.classList.toggle('open', abrir);
        el.btn.setAttribute('aria-expanded', String(abrir));
        if (abrir) {
            var nav = document.getElementById('mainNav');
            if (nav && nav.classList.contains('open')) {
                var toggle = document.querySelector('.nav-toggle');
                if (toggle) toggle.click();
            }
            carregarNotificacoes();
        }
    }

    function pintarContador(total) {
        naoLidas = total;
        if (!el.badge) return;
        if (total > 0) {
            el.badge.textContent = total > 9 ? '9+' : total;
            el.badge.classList.add('show');
            el.btn.setAttribute('aria-label', 'Notificações (' + total + ' não lida' + (total > 1 ? 's' : '') + ')');
            el.count.textContent = total + (total > 1 ? ' novas' : ' nova');
            el.count.hidden = false;
        } else {
            el.badge.classList.remove('show');
            el.btn.setAttribute('aria-label', 'Notificações');
            el.count.hidden = true;
        }
        el.lerTodas.disabled = total === 0;
    }

    async function atualizarContador() {
        try {
            var resposta = await fetch(API_URL + '/notificacoes/nao-lidas', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var dados = await resposta.json();
            pintarContador(resposta.ok ? (dados.total || 0) : 0);
        } catch (erro) {
            console.error('Erro ao atualizar notificacoes:', erro);
        }
    }

    function estado(icone, titulo, texto, classe) {
        return '<div class="notif-state ' + (classe || '') + '"><i class="fas ' + icone + '"></i>' +
            '<strong>' + esc(titulo) + '</strong>' + (texto ? esc(texto) : '') + '</div>';
    }

    async function carregarNotificacoes() {
        if (!el.lista) return;

        if (!notificacoes.length) {
            el.lista.innerHTML = estado('fa-spinner fa-spin', 'Carregando…', '');
        }

        try {
            var resposta = await fetch(API_URL + '/notificacoes', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var dados = await resposta.json();

            if (!resposta.ok) throw new Error(dados.mensagem || 'Erro');

            notificacoes = Array.isArray(dados) ? dados : [];
            pintarContador(notificacoes.filter(function (n) { return !n.lida; }).length);
            renderizar();
        } catch (erro) {
            el.lista.innerHTML = estado('fa-triangle-exclamation', 'Não foi possível carregar', 'Verifique sua conexão e tente novamente.', 'is-error');
        }
    }

    function renderizar() {
        if (!notificacoes.length) {
            el.lista.innerHTML = estado('fa-bell-slash', 'Tudo em dia', 'Você não tem notificações por enquanto.');
            return;
        }

        el.lista.innerHTML = notificacoes.map(function (n) {
            var tipo = TIPOS[n.tipo] || { titulo: 'Aviso', icone: 'fa-bell', classe: '' };
            var texto = TEXTOS[n.mensagem] || n.mensagem;
            return '<button type="button" class="notif-item' + (n.lida ? '' : ' unread') + '" data-id="' + esc(n._id) + '" data-link="' + esc(n.link || '') + '">' +
                '<span class="notif-icon ' + tipo.classe + '"><i class="fas ' + tipo.icone + '"></i></span>' +
                '<span>' +
                    '<span class="notif-title">' + esc(tipo.titulo) + '</span>' +
                    '<span class="notif-text">' + esc(texto) + '</span>' +
                    '<span class="notif-time">' + esc(tempo(n.data_criacao)) + '</span>' +
                '</span>' +
                '<span class="notif-dot" aria-hidden="true"></span>' +
            '</button>';
        }).join('');

        el.lista.querySelectorAll('.notif-item').forEach(function (item) {
            item.addEventListener('click', function () { abrirNotificacao(item); });
        });
    }

    async function marcarLida(id) {
        await fetch(API_URL + '/notificacoes/' + encodeURIComponent(id) + '/lida', {
            method: 'PUT',
            headers: { 'Authorization': 'Bearer ' + token }
        });
        notificacoes.forEach(function (n) { if (n._id === id) n.lida = true; });
    }

    async function abrirNotificacao(item) {
        var id = item.dataset.id;
        var link = (item.dataset.link || '').replace(/^\//, '');
        var notif = notificacoes.find(function (n) { return n._id === id; });

        if (notif && !notif.lida) {
            try {
                await marcarLida(id);
                pintarContador(Math.max(0, naoLidas - 1));
                item.classList.remove('unread');
            } catch (erro) {
                console.error('Erro ao marcar notificacao:', erro);
            }
        }

        if (!link) return;

        var paginaAtual = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
        var destino = link.split(/[?#]/)[0].toLowerCase();
        if (destino === paginaAtual) {
            alternar(false);
            return;
        }
        window.location.href = link;
    }

    async function marcarTodas() {
        var pendentes = notificacoes.filter(function (n) { return !n.lida; });
        if (!pendentes.length) return;

        el.lerTodas.disabled = true;
        try {
            await Promise.all(pendentes.map(function (n) { return marcarLida(n._id); }));
        } catch (erro) {
            console.error('Erro ao marcar notificacoes:', erro);
        }
        renderizar();
        atualizarContador();
    }
})();
