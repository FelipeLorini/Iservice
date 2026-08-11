document.addEventListener("DOMContentLoaded", () => {
    startMenu();
    startButtons();
    startLogin();
    startRegister();
    startScrollSpy();
});

function startMenu() {
    const links = document.querySelectorAll(".menu a");

    links.forEach((link) => {
        const href = link.getAttribute("href");

        if (href.startsWith("#")) {
            link.addEventListener("click", (event) => {
                event.preventDefault();

                const section = document.querySelector(href);

                if (section) {
                    section.scrollIntoView({
                        behavior: "smooth"
                    });
                }
            });
        }
    });
}

function startButtons() {
    const contractButton = document.getElementById("btnContratar");

    if (contractButton) {
        contractButton.addEventListener("click", goToLogin);
    }
}

function startLogin() {
    const form = document.getElementById("loginForm");

    if (!form) return;

    form.addEventListener("submit", (event) => {
        event.preventDefault();

        const email = document.getElementById("email").value;
        const senha = document.getElementById("senha").value;

        validateLogin(email, senha);
    });
}

function validateLogin(email, senha) {
    const emailPadrao = "admin@email.com";
    const senhaPadrao = "123";

    let usuarios = JSON.parse(localStorage.getItem("usuarios")) || [];
    const usuarioEncontrado = usuarios.find(u => u.email === email && u.senha === senha);

    if (usuarioEncontrado) {
        alert(`Bem-vindo, ${usuarioEncontrado.nome}!`);
        window.location.href = "index.html";
        return;
    }

    if (email === emailPadrao && senha === senhaPadrao) {
        alert("Login realizado com sucesso!");
        window.location.href = "index.html";
        return;
    }

    alert("Email ou senha inválidos.");
}

function clearLoginForm() {
    document.getElementById("email").value = "";
    document.getElementById("senha").value = "";
}

function startRegister() {
    const form = document.getElementById("registerForm");
    const tipoBtns = document.querySelectorAll(".tipo-btn");
    const prestadorFields = document.getElementById("prestadorFields");
    let tipoCadastro = "cliente";

    if (tipoBtns.length > 0) {
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
    }

    if (!form) return;

    form.addEventListener("submit", (event) => {
        event.preventDefault();

        const nome = document.getElementById("nome").value;
        const email = document.getElementById("registerEmail").value;
        const senha = document.getElementById("registerSenha").value;

        if (!nome || !email || !senha) {
            alert("Preencha todos os campos obrigatórios!");
            return;
        }

        if (senha.length < 6) {
            alert("A senha deve ter no mínimo 6 caracteres!");
            return;
        }

        const usuario = {
            nome: nome,
            email: email,
            senha: senha,
            tipo: tipoCadastro
        };

        if (tipoCadastro === "prestador") {
            const especialidade = document.getElementById("especialidade").value;
            const descricao = document.getElementById("descricao").value;

            if (!especialidade) {
                alert("Selecione sua especialidade!");
                return;
            }

            usuario.especialidade = especialidade;
            usuario.descricao = descricao;
        }

        let usuarios = JSON.parse(localStorage.getItem("usuarios")) || [];
        usuarios.push(usuario);
        localStorage.setItem("usuarios", JSON.stringify(usuarios));

        alert("Conta criada com sucesso!");
        window.location.href = "login.html";
    });
}

function startScrollSpy() {
    const sections = document.querySelectorAll("section");
    const links = document.querySelectorAll(".menu a");

    window.addEventListener("scroll", () => {
        let currentSection = "";

        sections.forEach((section) => {
            const top = section.offsetTop - 150;
            const height = section.offsetHeight;

            if (window.scrollY >= top && window.scrollY < top + height) {
                currentSection = section.id;
            }
        });

        links.forEach((link) => {
            link.classList.remove("active");

            if (link.getAttribute("href") === `#${currentSection}`) {
                link.classList.add("active");
            }
        });
    });
}

function goToLogin() {
    window.location.href = "login.html";
}

function loadStars() {
    const starsContainers = document.querySelectorAll(".stars");

    starsContainers.forEach((container) => {
        const rating = parseFloat(container.getAttribute("data-rating"));
        const stars = container.querySelectorAll(".star");

        stars.forEach((star, index) => {
            const starNumber = index + 1;

            if (starNumber <= rating) {
                star.classList.add("filled");
            } else if (starNumber - 0.5 <= rating) {
                star.classList.add("half");
            }
        });
    });
}

loadStars();

function startAgendamento() {
    const btnAgendar = document.getElementById("btnAgendar");
    
    if (!btnAgendar) return;

    btnAgendar.addEventListener("click", () => {
        const servico = document.getElementById("servico").value;
        const data = document.getElementById("data").value;
        const horario = document.getElementById("horario").value;
        const msg = document.getElementById("msgAgendamento");

        if (!servico || !data || !horario) {
            msg.textContent = "Preencha todos os campos!";
            msg.className = "msg-erro";
            return;
        }

        const dataSelecionada = new Date(data + "T" + horario);
        const hoje = new Date();

        if (dataSelecionada <= hoje) {
            msg.textContent = "Escolha uma data e horário futuros!";
            msg.className = "msg-erro";
            return;
        }

        const agendamento = {
            servico: servico,
            data: data,
            horario: horario
        };

        let agendamentos = JSON.parse(localStorage.getItem("agendamentos")) || [];
        agendamentos.push(agendamento);
        localStorage.setItem("agendamentos", JSON.stringify(agendamentos));

        msg.textContent = "Agendamento realizado com sucesso!";
        msg.className = "msg-sucesso";

        document.getElementById("servico").value = "";
        document.getElementById("data").value = "";
        document.getElementById("horario").value = "";
    });
}