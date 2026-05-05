// Pass case: bufab-* naming, all required tags, no hardcoded secrets.
@description('Owner team email')
param ownerTeam string
param costCenter string
param projectId string

resource stg 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'bufab-prod-eastus-orders-stg'
  location: 'eastus'
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  tags: {
    Owner: ownerTeam
    CostCenter: costCenter
    ProjectID: projectId
  }
}
