# Fail case: missing tags, non-bufab name, hardcoded password.
resource "azurerm_sql_server" "y" {
  name                         = "mysqlsvr"
  resource_group_name          = "rg-foo"
  location                     = "eastus"
  version                      = "12.0"
  administrator_login          = "sqladmin"
  administrator_login_password = "Plaintext-Pass-123!"
}
