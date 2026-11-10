document.addEventListener("DOMContentLoaded", () => {
    startMenu();
    startButtons();
    startScrollSpy();
});

function startMenu() {
    const links = document.querySelectorAll(".menu a");

    links.forEach((link) => {
        const href = link.getAttribute("href");

        if (href && href.length > 1 && href.startsWith("#") && document.getElementById(href.slice(1))) {
            link.addEventListener("click", (event) => {
                event.preventDefault();

                const section = document.getElementById(href.slice(1));

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
    const links = Array.from(document.querySelectorAll('.menu a[href^="#"]'))
        .filter(link => document.getElementById(link.getAttribute('href').slice(1)));
    const sections = links.map(link => document.getElementById(link.getAttribute('href').slice(1)));

    function atualizarSecao() {
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
            link.removeAttribute('aria-current');

            if (link.getAttribute("href") === `#${currentSection}`) {
                link.classList.add("active");
                link.setAttribute('aria-current', 'location');
            }
        });
    }
    window.addEventListener("scroll", atualizarSecao);
    atualizarSecao();
}

function goToLogin() {
    window.location.href = "profissionais.html";
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
