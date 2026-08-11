const ServicoView = {
    init: function() {
        ServicoController.renderizarServicos("servicosContainer");
        this.initProfissionais();
    },

    initProfissionais: function() {
        const container = document.getElementById("profissionaisContainer");
        if (!container) return;

        const prestadores = UsuarioModel.listarPrestadores();

        if (prestadores.length === 0) {
            container.innerHTML = `
                <div class="card card-profissional">
                    <div class="avatar"><i class="fas fa-user"></i></div>
                    <h3>Nenhum profissional cadastrado</h3>
                    <p class="especialidade">Cadastre-se como prestador</p>
                    <button class="btn-contratar" onclick="window.location.href='cadastro.html'">
                        Cadastrar
                    </button>
                </div>
            `;
            return;
        }

        let html = '';
        prestadores.forEach(p => {
            html += `
                <div class="card card-profissional">
                    <div class="avatar"><i class="fas fa-user"></i></div>
                    <h3>${p.nome}</h3>
                    <p class="especialidade">${p.especialidade || "Prestador"}</p>
                    <p class="nota">★ 4.5</p>
                    <button class="btn-contratar" onclick="window.location.href='contratar.html'">
                        Contratar
                    </button>
                </div>
            `;
        });

        container.innerHTML = html;
    }
};