/* iService — navegação e utilidades compartilhadas.
   Carregado no <head> (sem defer) para marcar o estado de login antes da
   primeira pintura e disponibilizar as funções auxiliares (window.IS)
   para os scripts de cada página. */
(function () {
    var root = document.documentElement;
    var IS = window.IS = {};
    IS.API_URL = '/api';
    var token = null;
    var usuario = null;
    var expiraEm = 0;
    var timerSessao;
    var paginaProtegida = false;

    function limparArmazenamento() {
        try {
            localStorage.removeItem('token');
            localStorage.removeItem('usuario');
        } catch (e) { /* Storage indisponível: ainda encerramos o estado em memória. */ }
    }

    function lerSessao() {
        try {
            var salvo = localStorage.getItem('token');
            var pessoa = JSON.parse(localStorage.getItem('usuario') || 'null');
            var partes = (salvo || '').split('.');
            if (partes.length !== 3 || !partes.every(function (p) { return /^[A-Za-z0-9_-]+$/.test(p); })) return null;
            function decodificar(parte) {
                var base64 = parte.replace(/-/g, '+').replace(/_/g, '/');
                base64 += '='.repeat((4 - base64.length % 4) % 4);
                return JSON.parse(decodeURIComponent(Array.from(atob(base64), function (c) {
                    return '%' + c.charCodeAt(0).toString(16).padStart(2, '0');
                }).join('')));
            }
            var cabecalho = decodificar(partes[0]);
            var dados = decodificar(partes[1]);
            var agora = Date.now() / 1000;
            if (!cabecalho || cabecalho.alg !== 'HS256' || !dados || !pessoa ||
                typeof pessoa.id !== 'string' || !pessoa.id ||
                !['cliente', 'prestador'].includes(pessoa.tipo) ||
                dados.id !== pessoa.id || dados.tipo !== pessoa.tipo ||
                typeof dados.exp !== 'number' || !Number.isFinite(dados.exp) || dados.exp <= agora ||
                (dados.nbf !== undefined && (typeof dados.nbf !== 'number' || dados.nbf > agora))) return null;
            // Decodificar não valida a assinatura. Este estado é apenas visual;
            // a API autoriza cada operação e um 401 invalida esta sessão.
            return { token: salvo, usuario: pessoa, expiraEm: dados.exp * 1000 };
        } catch (e) {
            return null;
        }
    }

    function aplicarSessao(sessao) {
        token = sessao ? sessao.token : null;
        usuario = sessao ? sessao.usuario : null;
        expiraEm = sessao ? sessao.expiraEm : 0;
        IS.token = token;
        IS.usuario = usuario;
        IS.logado = !!sessao;
        root.classList.remove('is-auth', 'is-guest', 'is-cliente', 'is-prestador');
        root.classList.add(sessao ? 'is-auth' : 'is-guest');
        if (usuario) root.classList.add('is-' + usuario.tipo);
        clearTimeout(timerSessao);
        if (sessao) timerSessao = setTimeout(sincronizarSessao, Math.min(expiraEm - Date.now(), 2147483647));
    }

    function atualizarDestinos() {
        document.querySelectorAll('[data-link="dashboard"]').forEach(function (a) { a.href = IS.dashboardUrl(); });
        document.querySelectorAll('[data-link="perfil"]').forEach(function (a) { a.href = IS.perfilUrl(); });
    }

    function sincronizarSessao() {
        var anterior = token;
        var sessao = lerSessao();
        if (!sessao) limparArmazenamento();
        aplicarSessao(sessao);
        atualizarDestinos();
        if (paginaProtegida && !sessao) window.location.replace('login.html');
        else if (sessao && anterior !== token) window.location.reload();
    }

    var inicial = lerSessao();
    if (!inicial) limparArmazenamento();
    aplicarSessao(inicial);

    IS.exigirSessao = function (tipo) {
        paginaProtegida = true;
        if (!IS.logado) {
            window.location.replace('login.html');
            return false;
        }
        if (tipo && usuario.tipo !== tipo) {
            window.location.replace(IS.dashboardUrl());
            return false;
        }
        return true;
    };

    window.addEventListener('storage', function (event) {
        if (event.key === null || event.key === 'token' || event.key === 'usuario') sincronizarSessao();
    });
    window.addEventListener('pageshow', sincronizarSessao);

    // Observa somente respostas da nossa API que usaram a sessão atual.
    // Mantém Request/Response, corpo, headers e rejeições de rede intactos.
    var fetchOriginal = window.fetch;
    window.fetch = async function (input, options) {
        var usado = null;
        try {
            var url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
            var headers = new Headers(options && options.headers !== undefined ? options.headers : input.headers);
            if (url.origin === location.origin && url.pathname.startsWith('/api/') &&
                !['/api/login', '/api/cadastro'].includes(url.pathname)) {
                usado = headers.get('Authorization');
            }
        } catch (e) { /* Deixa a validação da requisição com o fetch nativo. */ }
        var resposta = await fetchOriginal.apply(window, arguments);
        var tokenAtual = null;
        try { tokenAtual = localStorage.getItem('token'); } catch (e) { /* Sem storage. */ }
        if (resposta.status === 401 && token && usado === 'Bearer ' + token &&
            tokenAtual === token) IS.sair();
        return resposta;
    };

    IS.dashboardUrl = function () {
        return usuario && usuario.tipo === 'prestador' ? 'dashboard-prestador.html' : 'dashboard-cliente.html';
    };

    IS.perfilUrl = function () {
        return usuario && usuario.tipo === 'prestador' ? 'perfil_prestador.html' : 'perfil_cliente.html';
    };

    IS.esc = function (valor) {
        if (valor === null || valor === undefined) return '';
        return String(valor).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };

    IS.moeda = function (valor) {
        var n = Number(valor);
        if (!isFinite(n)) return 'R$ —';
        return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    };

    /* Datas salvas só com dia (yyyy-mm-dd) chegam como meia-noite UTC;
       formatar em UTC evita mostrar o dia anterior no fuso de Brasília. */
    IS.data = function (valor) {
        var d = new Date(valor);
        if (isNaN(d)) return '—';
        return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    };

    IS.dataTile = function (valor) {
        var d = new Date(valor);
        if (isNaN(d)) return { dia: '--', mes: '---' };
        var meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
        return { dia: String(d.getUTCDate()).padStart(2, '0'), mes: meses[d.getUTCMonth()] };
    };

    IS.tempoRelativo = function (valor) {
        var d = new Date(valor);
        if (isNaN(d)) return '';
        var seg = Math.round((d.getTime() - Date.now()) / 1000);
        var abs = Math.abs(seg);
        var rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
        if (abs < 60) return 'agora mesmo';
        if (abs < 3600) return rtf.format(Math.round(seg / 60), 'minute');
        if (abs < 86400) return rtf.format(Math.round(seg / 3600), 'hour');
        if (abs < 86400 * 7) return rtf.format(Math.round(seg / 86400), 'day');
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    };

    IS.inicial = function (nome) {
        return (String(nome || '?').trim()[0] || '?').toUpperCase();
    };

    IS.STATUS = {
        pendente: ['Pendente', 'warning'],
        confirmado: ['Confirmado', 'success'],
        cancelado: ['Cancelado', 'danger'],
        finalizado: ['Finalizado', 'info'],
        aceita: ['Aceita', 'success'],
        recusada: ['Recusada', 'danger'],
        enviada: ['Enviada', 'neutral'],
        aberto: ['Aberto', 'warning'],
        'em andamento': ['Em andamento', 'success'],
        ativo: ['Ativo', 'success']
    };

    IS.badge = function (status, extraClass) {
        var s = IS.STATUS[status] || [status || '—', 'neutral'];
        return '<span class="badge badge--' + s[1] + (extraClass ? ' ' + extraClass : '') + '">' + IS.esc(s[0]) + '</span>';
    };

    IS.CATEGORIAS = {
        faxina: { nome: 'Faxina', icone: 'fa-broom' },
        jardinagem: { nome: 'Jardinagem', icone: 'fa-seedling' },
        reparos: { nome: 'Reparos', icone: 'fa-tools' },
        eletrica: { nome: 'Elétrica', icone: 'fa-bolt' },
        pintura: { nome: 'Pintura', icone: 'fa-paint-roller' },
        encanamento: { nome: 'Encanamento', icone: 'fa-water' }
    };

    IS.categoria = function (chave) {
        return IS.CATEGORIAS[chave] || { nome: chave || 'Serviço', icone: 'fa-briefcase' };
    };

    IS.estrelas = function (nota) {
        var n = Math.max(0, Math.min(5, Number(nota) || 0));
        var arred = Math.round(n * 2) / 2;
        var html = '';
        for (var i = 1; i <= 5; i++) {
            if (i <= arred) html += '<i class="fas fa-star"></i>';
            else if (i - 0.5 === arred) html += '<i class="fas fa-star-half-stroke"></i>';
            else html += '<i class="far fa-star"></i>';
        }
        return '<span class="stars" aria-label="' + String(n).replace('.', ',') + ' de 5 estrelas">' + html + '</span>';
    };

    IS.vazio = function (icone, titulo, texto, classe) {
        return '<div class="empty ' + (classe || '') + '"><i class="fas ' + icone + '"></i>' +
            (titulo ? '<strong>' + IS.esc(titulo) + '</strong>' : '') +
            (texto ? '<p>' + IS.esc(texto) + '</p>' : '') + '</div>';
    };

    IS.msg = function (el, texto, tipo) {
        if (!el) return;
        el.textContent = texto || '';
        el.classList.remove('is-error', 'is-success');
        if (texto) el.classList.add(tipo === 'success' ? 'is-success' : 'is-error');
    };

    IS.toast = function (texto, tipo) {
        var stack = document.querySelector('.toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.className = 'toast-stack';
            stack.setAttribute('role', 'status');
            stack.setAttribute('aria-live', 'polite');
            document.body.appendChild(stack);
        }
        var t = document.createElement('div');
        t.className = 'toast' + (tipo === 'error' ? ' is-error' : '');
        t.innerHTML = '<i class="fas ' + (tipo === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check') + '"></i><span></span>';
        t.querySelector('span').textContent = texto;
        stack.appendChild(t);
        setTimeout(function () {
            t.classList.add('saindo');
            setTimeout(function () { t.remove(); }, 300);
        }, 3800);
    };

    IS.sair = function () {
        limparArmazenamento();
        aplicarSessao(null);
        atualizarDestinos();
        window.location.replace('login.html');
    };

    IS.abrirModal = function (id) {
        var m = document.getElementById(id);
        if (!m) return;
        m.classList.add('ativo');
        var foco = m.querySelector('input, textarea, select, button');
        if (foco) setTimeout(function () { foco.focus(); }, 30);
    };

    IS.fecharModal = function (id) {
        var m = document.getElementById(id);
        if (m) m.classList.remove('ativo');
    };

    function iniciarCabecalho() {
        atualizarDestinos();

        var atual = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
        document.querySelectorAll('.menu a').forEach(function (a) {
            var alvo = (a.getAttribute('href') || '').split('#')[0].toLowerCase();
            if (alvo && alvo === atual && !a.getAttribute('href').includes('#')) {
                a.classList.add('active');
                a.setAttribute('aria-current', 'page');
            }
        });

        document.querySelectorAll('[data-logout]').forEach(function (el) {
            el.addEventListener('click', function (e) {
                e.preventDefault();
                IS.sair();
            });
        });

        var nav = document.getElementById('mainNav');
        var toggle = document.querySelector('.nav-toggle');
        if (nav && toggle) {
            var setMenu = function (aberto) {
                nav.classList.toggle('open', aberto);
                toggle.setAttribute('aria-expanded', String(aberto));
                toggle.innerHTML = aberto ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
            };
            toggle.addEventListener('click', function (e) {
                e.stopPropagation();
                setMenu(!nav.classList.contains('open'));
            });
            nav.querySelectorAll('a').forEach(function (link) {
                link.addEventListener('click', function () { setMenu(false); });
            });
            document.addEventListener('click', function (e) {
                if (nav.classList.contains('open') && !nav.contains(e.target)) setMenu(false);
            });
        }
    }

    function iniciarModais() {
        document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) overlay.classList.remove('ativo');
            });
        });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            document.querySelectorAll('.modal-overlay.ativo').forEach(function (m) { m.classList.remove('ativo'); });
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        iniciarCabecalho();
        iniciarModais();
    });
})();
