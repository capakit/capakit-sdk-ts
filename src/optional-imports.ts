export function optionalModule(specifier: string): string {
    return specifier;
}

export function optionalPackageJson(packageName: string): string {
    return `${packageName}/package.json`;
}
