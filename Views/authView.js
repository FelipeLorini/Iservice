const AuthView = {
    initLogin: function() {
        const form = document.getElementById("loginForm");
        if (!form) return;

        form.addEventListener("submit", function(event) {
            event.preventDefault();

            const email = document.getElementById("email").value;
            const senha = document.getElementById("senha").value;
            const msg = document.getElementById("msgLogin");

            const resultado = AuthController.login(email, senha);

            if (resultado.sucesso) {
                msg.textContent = "";
                AuthController.redirecionarPorTipo(resultado.usuario);
            } else {
                msg.textContent = resultado.mensagem;
            }
        });
    },

    initRegister: function() {
        const form = document.getElementById("registerForm");
        if (!form) return;

        const tipoBtns = document.querySelectorAll(".tipo-btn");
        const prestadorFields = document.getElementById("prestadorFields");
        let tipoCadastro = "cliente";

        tipoBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                tipoBtns.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                
                tipoCadastro = btn.getAttribute("data-tipo");

                if (tipoCadastro === "prestador") {
                    prestadorFields.classList.add("show");
                } else {
                    prestadorFields.classList.remove("show");
                }
            });
        });

        form.addEventListener("submit", function(event) {
            event.preventDefault();

            const dados = {
                nome: document.getElementById("nome").value,
                email: document.getElementById("registerEmail").value,
                senha: document.getElementById("registerSenha").value,
                tipo: tipoCadastro
            };

            if (tipoCadastro === "prestador") {
                dados.especialidade = document.getElementById("especialidade").value;
                dados.descricao = document.getElementById("descricao").value;
            }

            const resultado = AuthController.registrar(dados);

            if (resultado.sucesso) {
                alert(resultado.mensagem);
                window.location.href = "login.html";
            } else {
                alert(resultado.mensagem);
            }
        });
    },

    initLogout: function() {
        const btnLogout = document.getElementById("logoutBtn");
        if (btnLogout) {
            btnLogout.addEventListener("click", function(e) {
                e.preventDefault();
                AuthController.logout();
            });
        }
    }
};