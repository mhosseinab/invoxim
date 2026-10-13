# Recurring command-token purpose

The existing signed workspace mutation token now recognizes the separate recurring purpose. Actor, session, purpose and expiry checks are unchanged. No additional credential, token mechanism or database query was introduced.

Behavioral RED: `/tmp/invoxim-recurring-token-red-v1.txt`, exit1, one intended runtime failure rejecting the recurring purpose. GREEN: `/tmp/invoxim-recurring-token-green-v1.txt`, exit0, three native tests/three files, 2.65s. The new case checks valid purpose, other-purpose denial, foreign actor/session denial and exact expiry; existing correction/storage token cases also pass. Focused Biome/ESLint/Prettier pass.

This makes the purpose available to the recurring route increment under implementation; it does not expose, enable or deploy those routes. Root owns Worker configuration/composition and public capabilities.
