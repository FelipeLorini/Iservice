/* Favoritos do Dashboard e do catalogo: a API e a fonte do estado. */
document.addEventListener('DOMContentLoaded', function () {
    if (!IS.usuario || IS.usuario.tipo !== 'cliente' || !IS.exigirSessao('cliente')) return;

    const token = IS.token;
    const usuarioId = IS.usuario.id;
    const chaveSincronizacao = 'iservice:favoritos:' + usuarioId;
    const lista = document.getElementById('listaFavoritos');
    const contador = document.getElementById('totalFavoritos');
    const alternarLista = document.getElementById('alternarListaFavoritos');
    const limiteInicial = 3;
    let listaExpandida = false;
    const estado = document.getElementById('estadoFavoritos');
    const dialog = document.getElementById('perfilFavorito');
    const conteudoPerfil = document.getElementById('conteudoPerfilFavorito');
    const esc = IS.esc;
    const idValido = id => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
    const sessaoAtual = () => IS.logado && IS.token === token && IS.usuario?.id === usuarioId;
    let itens = null;
    let carregando = false;
    let consulta = null;
    let reconsultar = false;
    let erroCarga = false;
    let mensagem = '';
    let mensagemErro = false;
    const operacoes = new Set();
    let numeroPerfil = 0;
    let perfilPendente = null;
    let idPerfil = null;

    function atualizarBotoes() {
        document.querySelectorAll('.btn-favorito[data-prestador]').forEach(botao => {
            const id = botao.dataset.prestador;
            const favorito = !!itens?.some(item => item.id === id);
            botao.disabled = !sessaoAtual() || itens === null || carregando || erroCarga || operacoes.has(id) || !idValido(id);
            botao.classList.toggle('favoritado', favorito);
            botao.setAttribute('aria-pressed', String(favorito));
            botao.setAttribute('aria-busy', String(operacoes.has(id)));
            const rotulo = (favorito ? 'Remover ' : 'Adicionar ') + (botao.dataset.nome || 'profissional') + (favorito ? ' dos favoritos' : ' aos favoritos');
            botao.setAttribute('aria-label', rotulo);
            botao.title = rotulo;
            const icone = botao.querySelector('i');
            if (icone) {
                icone.classList.toggle('fas', favorito);
                icone.classList.toggle('far', !favorito);
            }
        });
    }
    IS.favoritos = { atualizarBotoes };

    function renderizar() {
        if (!sessaoAtual()) {
            itens = null;
            listaExpandida = false;
            if (alternarLista) {
                alternarLista.hidden = true;
                alternarLista.setAttribute('aria-expanded', 'false');
            }
            if (lista) lista.innerHTML = '';
            if (contador) contador.textContent = '—';
            if (estado) estado.textContent = 'Sua sessão foi encerrada. Entre novamente para ver seus favoritos.';
            if (dialog?.open) dialog.close();
            atualizarBotoes();
            return;
        }
        if (contador) contador.textContent = itens === null ? '—' : String(itens.length);
        if (itens !== null && itens.length <= limiteInicial) listaExpandida = false;
        if (alternarLista) {
            alternarLista.hidden = itens === null || itens.length <= limiteInicial;
            alternarLista.disabled = carregando;
            alternarLista.setAttribute('aria-expanded', String(listaExpandida));
            alternarLista.textContent = listaExpandida ? 'Ver menos' : `Ver todos os ${itens?.length || 0} favoritos`;
        }
        if (estado) {
            estado.textContent = carregando ? 'Carregando favoritos…' : mensagem;
            estado.classList.toggle('is-error', !carregando && mensagemErro);
        }
        document.querySelectorAll('[data-favorito-acao="recarregar"]').forEach(botao => {
            botao.hidden = !erroCarga;
            botao.disabled = carregando;
        });
        if (lista) {
            lista.setAttribute('aria-busy', String(carregando));
            if (itens === null) {
                lista.innerHTML = carregando
                    ? IS.vazio('fa-spinner fa-spin', 'Carregando favoritos…', '', 'empty-sm')
                    : IS.vazio('fa-triangle-exclamation', 'Não foi possível carregar seus favoritos', 'Tente novamente abaixo.', 'empty-sm is-error');
            } else if (!itens.length) {
                lista.innerHTML = IS.vazio('fa-heart', 'Você ainda não tem favoritos', 'Explore os profissionais e toque no coração para salvá-los aqui.', 'empty-sm');
            } else {
                const visiveis = listaExpandida ? itens : itens.slice(0, limiteInicial);
                lista.innerHTML = visiveis.map(item => {
                    const removendo = operacoes.has(item.id);
                    return `<article class="person list-row favorito-item">
                        <span class="avatar avatar-sm">${esc(IS.inicial(item.nome))}</span>
                        <div class="favorito-info"><span class="row-title">${esc(item.nome)}</span><span class="row-sub">Profissional favorito</span></div>
                        <div class="row-actions">
                            <button type="button" class="btn btn-ghost btn-sm" data-favorito-acao="perfil" data-prestador="${item.id}" aria-label="Ver perfil de ${esc(item.nome)}">Ver perfil</button>
                            <button type="button" class="btn btn-ghost btn-sm" data-favorito-acao="conversar" data-prestador="${item.id}" aria-label="Conversar com ${esc(item.nome)}">Conversar</button>
                            <button type="button" class="btn btn-ghost btn-sm favorito-remover" data-favorito-acao="remover" data-prestador="${item.id}" aria-label="Remover ${esc(item.nome)} dos favoritos" aria-busy="${removendo}" ${removendo || carregando ? 'disabled' : ''}>${removendo ? 'Removendo…' : 'Remover'}</button>
                        </div>
                    </article>`;
                }).join('');
            }
        }
        atualizarBotoes();
    }

    async function requisicao(caminho, options = {}) {
        if (!sessaoAtual()) throw new Error('Sessao encerrada');
        const resposta = await fetch(IS.API_URL + caminho, {
            ...options, headers: { ...options.headers, Authorization: 'Bearer ' + token }
        });
        if (resposta.status === 401 && sessaoAtual()) IS.sair();
        if (!sessaoAtual()) throw new Error('Sessao encerrada');
        if (!resposta.ok) throw new Error('Falha na requisicao');
        return resposta;
    }

    function carregar() {
        if (!sessaoAtual()) { renderizar(); return Promise.resolve(); }
        // Uma leitura iniciada durante a remocao poderia restaurar dados antigos.
        if (operacoes.size) { reconsultar = true; return Promise.resolve(); }
        if (consulta) return consulta;
        carregando = true;
        renderizar();
        consulta = (async () => {
            try {
                const resposta = await requisicao('/favoritos', { cache: 'no-store' });
                const dados = await resposta.json();
                if (!Array.isArray(dados)) throw new Error('Resposta invalida');
                if (!sessaoAtual()) return;
                const unicos = new Map();
                dados.forEach(favorito => {
                    const prestador = favorito?.prestador_id;
                    if (!prestador || !idValido(prestador._id)) return;
                    unicos.set(prestador._id, {
                        id: prestador._id,
                        nome: typeof prestador.nome === 'string' && prestador.nome.trim() ? prestador.nome : 'Prestador'
                    });
                });
                itens = [...unicos.values()];
                erroCarga = false;
                mensagem = '';
                mensagemErro = false;
            } catch (erro) {
                erroCarga = true;
                mensagem = itens === null ? 'Não foi possível carregar seus favoritos.' : 'Não foi possível atualizar. Exibindo a última lista consultada.';
                mensagemErro = true;
            } finally {
                carregando = false;
                consulta = null;
                renderizar();
                if (reconsultar && !operacoes.size) { reconsultar = false; carregar(); }
            }
        })();
        return consulta;
    }

    async function alterar(id, adicionar, nome) {
        if (!sessaoAtual() || !idValido(id) || itens === null || carregando || operacoes.has(id)) return;
        if (!adicionar && !itens.some(item => item.id === id)) return;
        operacoes.add(id);
        mensagem = '';
        mensagemErro = false;
        renderizar();
        try {
            await requisicao(adicionar ? '/favoritos' : '/favoritos/' + id, adicionar ? {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prestador_id: id })
            } : { method: 'DELETE' });
            if (!sessaoAtual()) return;
            itens = itens.filter(item => item.id !== id);
            if (adicionar) itens.push({ id, nome: nome || 'Prestador' });
            mensagem = adicionar ? 'Profissional adicionado aos favoritos.' : 'Profissional removido dos favoritos.';
            mensagemErro = false;
            // Apenas um aviso entre abas; nomes, IDs de prestadores e listas nao sao armazenados.
            try { localStorage.setItem(chaveSincronizacao, Date.now() + ':' + Math.random()); } catch (erro) { /* O retorno a aba tambem atualiza a lista. */ }
        } catch (erro) {
            mensagem = adicionar ? 'Não foi possível adicionar. Tente novamente.' : 'Não foi possível remover. O profissional continua na lista; tente novamente.';
            mensagemErro = true;
        } finally {
            operacoes.delete(id);
            renderizar();
            if (lista && sessaoAtual()) document.getElementById('tituloFavoritos').focus({ preventScroll: true });
            if (!operacoes.size && reconsultar) { reconsultar = false; carregar(); }
        }
    }

    async function abrirPerfil(id) {
        if (!dialog || !sessaoAtual() || !itens?.some(item => item.id === id) || perfilPendente === id) return;
        const pedido = ++numeroPerfil;
        perfilPendente = id;
        idPerfil = id;
        conteudoPerfil.innerHTML = IS.vazio('fa-spinner fa-spin', 'Carregando perfil…', '', 'empty-sm');
        conteudoPerfil.setAttribute('aria-busy', 'true');
        if (!dialog.open) dialog.showModal();
        try {
            const resposta = await requisicao('/usuario/' + id + '/perfil', { cache: 'no-store' });
            const perfil = await resposta.json();
            if (pedido !== numeroPerfil || !sessaoAtual()) return;
            if (perfil.id !== id || perfil.tipo !== 'prestador' || typeof perfil.nome !== 'string') throw new Error('Perfil invalido');
            const fotos = Array.isArray(perfil.portifolio) ? perfil.portifolio.filter(url => {
                if (typeof url !== 'string') return false;
                try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch (erro) { return false; }
            }) : [];
            conteudoPerfil.innerHTML = `<h4 class="row-title">${esc(perfil.nome)}</h4>
                <p class="row-sub">${perfil.online ? 'Acesso recente' : 'Sem acesso recente'}</p>
                <p class="favorito-descricao">${esc(typeof perfil.descricao_detalhada === 'string' && perfil.descricao_detalhada ? perfil.descricao_detalhada : 'Este profissional ainda não adicionou uma descrição.')}</p>
                <div class="favorito-portfolio">${fotos.map(url => `<img src="${esc(url)}" alt="Foto do portfólio de ${esc(perfil.nome)}" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>`;
        } catch (erro) {
            if (pedido === numeroPerfil && sessaoAtual()) conteudoPerfil.innerHTML = IS.vazio('fa-triangle-exclamation', 'Perfil indisponível', 'Feche esta janela e tente novamente. O profissional pode não estar mais disponível.', 'empty-sm is-error');
        } finally {
            if (pedido === numeroPerfil) {
                perfilPendente = null;
                conteudoPerfil.setAttribute('aria-busy', 'false');
            }
            if (!sessaoAtual()) renderizar();
        }
    }

    document.addEventListener('click', async function (event) {
        const botao = event.target.closest('[data-favorito-acao]');
        if (!botao || botao.disabled) return;
        if (!sessaoAtual()) { renderizar(); return; }
        const id = botao.dataset.prestador;
        switch (botao.dataset.favoritoAcao) {
            case 'expandir':
                if (!lista || !itens || itens.length <= limiteInicial || carregando) return;
                listaExpandida = !listaExpandida;
                renderizar();
                return;
            case 'recarregar': return carregar();
            case 'perfil': return abrirPerfil(id);
            case 'remover': return alterar(id, false);
            case 'alternar': return alterar(id, !itens?.some(item => item.id === id), botao.dataset.nome);
            case 'conversar':
                if (!idValido(id) || !itens?.some(item => item.id === id)) return;
                botao.disabled = true;
                try { await window.abrirChat(id); } finally { botao.disabled = false; }
        }
    });
    if (dialog) {
        document.getElementById('fecharPerfilFavorito').addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => {
            numeroPerfil++;
            perfilPendente = null;
            if (sessaoAtual()) {
                const origem = Array.from(lista.querySelectorAll('[data-favorito-acao="perfil"]')).find(botao => botao.dataset.prestador === idPerfil);
                (origem || document.getElementById('tituloFavoritos')).focus({ preventScroll: true });
            }
            idPerfil = null;
        });
    }
    window.addEventListener('storage', event => {
        if (!sessaoAtual()) { renderizar(); return; }
        if (event.key === chaveSincronizacao) {
            if (consulta) reconsultar = true;
            else carregar();
        }
    });
    window.addEventListener('focus', carregar);
    window.addEventListener('pageshow', event => { if (event.persisted) carregar(); });
    carregar();
});
