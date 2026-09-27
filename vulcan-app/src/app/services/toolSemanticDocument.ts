export function canonicalToolDocument(kitName: string, tool: any): string {
  const properties = tool?.parameters?.properties && typeof tool.parameters.properties === 'object'
    ? tool.parameters.properties : {};
  const parameterNames = Object.keys(properties).join(' ');
  const parameterDescriptions = Object.values(properties)
    .map((value: any) => String(value?.description ?? '')).join(' ');
  const fields = [
    String(tool?.name ?? '').replace(/_/g, ' ').toLowerCase(),
    String(tool?.description ?? '').toLowerCase(),
    String(kitName ?? '').replace(/_/g, ' ').toLowerCase(),
    parameterNames.replace(/_/g, ' ').toLowerCase(),
    parameterDescriptions.toLowerCase(),
  ];
  return fields.filter(Boolean).join(' ').trim();
}
