document.addEventListener("DOMContentLoaded", () => {
    startMenu();
    startButtons();
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