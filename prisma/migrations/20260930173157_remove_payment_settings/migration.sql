-- Removes PaymentSettings: bank details are read directly from env vars
-- again (BANK_NAME / BANK_ACCOUNT_NAME / BANK_ACCOUNT_NUMBER) rather than
-- an admin-editable DB row.
DROP TABLE "PaymentSettings";
