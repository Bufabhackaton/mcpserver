// Fail case: missing tags, non-bufab name, hardcoded AccountKey.
resource stg 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'mystorage123'
  location: 'eastus'
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowSharedKeyAccess: true
  }
}

var conn = 'DefaultEndpointsProtocol=https;AccountName=foo;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789AB==;EndpointSuffix=core.windows.net'
