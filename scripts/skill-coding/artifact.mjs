import ts from 'typescript';
export function inspectArtifact(files, fixture) {
    const violations = [];
    if (fixture.id !== 'review') return violations;
    for (const [path, content] of Object.entries(files)) {
        if (!path.endsWith('.mjs')) continue;
        const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        function visit(node) {
            if ((ts.isIfStatement(node) && ts.isBlock(node.thenStatement) && node.thenStatement.statements.length === 0)
                || (ts.isIfStatement(node) && node.elseStatement && ts.isBlock(node.elseStatement) && node.elseStatement.statements.length === 0)
                || (ts.isCatchClause(node) && node.block.statements.length === 0)) violations.push({path, reason:'empty_branch'});
            // This fixture explicitly asks to remove this seeded, unregistered helper.
            if (ts.isFunctionDeclaration(node) && node.name?.text === 'abandoned') violations.push({path,reason:'seeded_dead_helper'});
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    return violations;
}
