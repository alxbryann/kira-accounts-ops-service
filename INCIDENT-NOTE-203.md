# Incident note · Payout shown as "failed" although it was paid (TICKET-203)
**Client:** Marea Pay S.A. · **Reference:** CID-203 · **Status:** Resolved

*Español más abajo.*

---

## English

Dear Marea Pay team,

Thank you for flagging this so quickly. Here is a clear account of what happened with your $750.00 payout, what we have changed, and the one adjustment you will see on your account.

**What happened**
Your $750.00 payout was **paid successfully**: the vendor received the funds once, as intended. However, our dashboard showed the payout as "failed", and your available balance appeared **$771.75 higher** than it should have been (the $750.00 payout plus its $21.75 fee). No money was lost and nothing was paid twice. The problem was in how our system recorded the outcome, not in the payment itself.

**Why it happened**
Our payment provider sent us two status updates for the same payout: first "paid", then, moments later, an outdated "failed" message. Our system applied both updates in the order they arrived instead of checking what had already happened. As a result, the second message overwrote the correct status and gave back funds that had already left your account.

**What we fixed**
- Our system now checks the payout's current status before applying any update. Once a payout is confirmed as paid, a late or contradictory message can no longer change it or return funds. A genuine return from the vendor's bank is still handled correctly.
- We tested this against every combination of provider messages, including messages that arrive at the same time, not only the sequence that affected you.

**What changes on your account**
- The payout now correctly shows as **paid**.
- We are posting a single correcting entry of **$771.75**, so your available balance matches the funds you actually hold. Your balance was temporarily showing more than was really there. This entry removes that difference. It is not a new charge.
- If you made payment decisions based on the higher balance, please let us know and we will help you review them.

**How we are preventing this in the future**
We added an automatic daily check that compares every payout with the provider's own records. It alerts our operations team immediately if a status or a balance ever disagrees, so a case like this is caught and corrected before it reaches you.

We apologise for the confusion this caused. If you have any questions, reply to this message or contact your account manager. We are happy to walk you through the details on a call.

Kind regards,
Kira Integrations Team

---

## Español

Estimado equipo de Marea Pay:

Gracias por avisarnos tan rápido. A continuación les explicamos con claridad qué pasó con su pago de USD 750.00, qué cambiamos y el único ajuste que verán en su cuenta.

**Qué pasó**
Su pago de USD 750.00 **se realizó correctamente**: el proveedor recibió los fondos una sola vez, como correspondía. Sin embargo, nuestro panel mostraba el pago como "fallido" y su saldo disponible aparecía **USD 771.75 más alto** de lo que debía (el pago de USD 750.00 más su comisión de USD 21.75). No se perdió dinero ni se pagó nada dos veces. El problema estuvo en cómo nuestro sistema registró el resultado, no en el pago en sí.

**Por qué pasó**
Nuestro proveedor de pagos nos envió dos actualizaciones de estado para el mismo pago: primero "pagado" y, momentos después, un mensaje desactualizado de "fallido". Nuestro sistema aplicó ambas actualizaciones en el orden en que llegaron, sin verificar lo que ya había ocurrido. Por eso, el segundo mensaje sobrescribió el estado correcto y devolvió a su saldo fondos que ya habían salido de su cuenta.

**Qué corregimos**
- Ahora nuestro sistema revisa el estado actual del pago antes de aplicar cualquier actualización. Una vez que un pago está confirmado como pagado, un mensaje tardío o contradictorio ya no puede cambiarlo ni devolver fondos. Una devolución real por parte del banco del proveedor se sigue procesando correctamente.
- Lo probamos contra todas las combinaciones posibles de mensajes del proveedor, incluso mensajes que llegan al mismo tiempo, y no solo contra la secuencia que los afectó a ustedes.

**Qué cambia en su cuenta**
- El pago ahora aparece correctamente como **pagado**.
- Registraremos un único ajuste de **USD 771.75** para que su saldo disponible coincida con los fondos que realmente tienen. Su saldo mostraba temporalmente más de lo que había en realidad, y este ajuste corrige esa diferencia. No es un cargo nuevo.
- Si tomaron decisiones de pago basándose en el saldo más alto, avísennos y los ayudaremos a revisarlas.

**Cómo lo prevenimos a futuro**
Agregamos una verificación automática diaria que compara cada pago con los registros del propio proveedor. Si un estado o un saldo no coinciden, alerta de inmediato a nuestro equipo de operaciones, para que un caso así se detecte y se corrija antes de que llegue a ustedes.

Lamentamos la confusión que esto les causó. Si tienen cualquier pregunta, respondan a este mensaje o contacten a su gerente de cuenta. Con gusto les explicamos los detalles en una llamada.

Saludos cordiales,
Equipo de Integraciones de Kira
