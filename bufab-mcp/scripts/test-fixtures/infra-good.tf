# Pass case: bufab-* naming, all required tags, no hardcoded secrets.
resource "azurerm_storage_account" "x" {
  name                     = "bufab-prod-eastus-orders-stg"
  resource_group_name      = "rg-bufab-prod"
  location                 = "eastus"
  account_tier             = "Standard"
  account_replication_type = "LRS"

  tags = {
    Owner      = "team-orders"
    CostCenter = "CC-1234"
    ProjectID  = "P-9999"
  }
}
