const AgendamentoView = {
    init: function() {
        const btnAgendar = document.getElementById("btnAgendar");
        if (btnAgendar) {
            btnAgendar.addEventListener("click", this.handleAgendamento.bind(this));
        }

        AgendamentoController.renderizarAgendamentos("listaAgendamentos");
    },

    handleAgendamento: function() {
        const servico = document.getElementById("servico").value;
        const data = document.getElementById("data").value;
        const horario = document.getElementById("horario").value;
        const msg = document.getElementById("msgAgendamento");

        const resultado = AgendamentoController.criarAgendamento({
            servico: servico,
            data: data,
            horario: horario
        });

        msg.textContent = resultado.mensagem;
        msg.className = resultado.sucesso ? "msg-sucesso" : "msg-erro";

        if (resultado.sucesso) {
            document.getElementById("servico").value = "";
            document.getElementById("data").value = "";
            document.getElementById("horario").value = "";
            AgendamentoController.renderizarAgendamentos("listaAgendamentos");
        }
    }
};