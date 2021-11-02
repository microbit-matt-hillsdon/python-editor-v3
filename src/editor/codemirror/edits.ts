/**
 * Code-aware edits to CodeMirror Python text.
 *
 * (c) 2021, Micro:bit Educational Foundation and contributors
 *
 * SPDX-License-Identifier: MIT
 */
import { python } from "@codemirror/lang-python";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { SyntaxNode, Tree } from "@lezer/common";

export interface RequiredImport {
  module: string;
  name?: string;
}

type SimpleChangeSpec = {
  from: number;
  to?: number;
  insert: string;
};

const calculateImportChangesInternal = (
  allCurrent: ImportNode[],
  required: RequiredImport
): SimpleChangeSpec[] => {
  const from = allCurrent.length
    ? allCurrent[allCurrent.length - 1].node.to
    : 0;
  const to = from;
  const prefix = to > 0 ? "\n" : "";

  if (!required.name) {
    // Module import.
    if (
      allCurrent.find(
        (c) => !c.names && c.module === required.module && !c.alias
      )
    ) {
      return [];
    } else {
      return [{ from, to, insert: `${prefix}import ${required.module}` }];
    }
  } else if (required.name === "*") {
    // Wildcard import.
    if (
      allCurrent.find(
        (c) =>
          c.names?.length === 1 &&
          c.names[0].name === "*" &&
          c.module === required.module
      )
    ) {
      return [];
    } else {
      return [
        { from, to, insert: `${prefix}from ${required.module} import *` },
      ];
    }
  } else {
    // Importing some name from a module.
    const partMatches = allCurrent.filter(
      (c) =>
        c.names &&
        !(c.names?.length === 1 && c.names[0].name === "*") &&
        c.module === required.module
    );
    const fullMatch = partMatches.find((nameImport) =>
      nameImport.names?.find((n) => n.name === required.name && !n.alias)
    );
    if (fullMatch) {
      return [];
    } else if (partMatches.length > 0) {
      return [
        {
          from: partMatches[0].node.to,
          to: partMatches[0].node.to,
          insert: `, ${required.name}`,
        },
      ];
    } else {
      return [
        {
          from,
          to,
          insert: `${prefix}from ${required.module} import ${required.name}`,
        },
      ];
    }
  }
};

/**
 * A representation of an import node.
 * The CodeMirror tree isn't easy to work with so we convert to these.
 */
interface ImportNode {
  kind: "import" | "from";
  module: string;
  alias?: string;
  names?: ImportedName[];
  node: SyntaxNode;
}

/**
 * An imported name with alias.
 */
interface ImportedName {
  name: string;
  alias?: string;
}

/**
 * A relative insertion position to some node.
 * Default is used when there is no relative insertion point (e.g. in the empty document case).
 */
enum Relation {
  Before,
  After,
  Default,
}

class AliasesNotSupportedError extends Error {}

/**
 * Calculate the changes needed to insert the given code into the editor.
 * Imports are separated and merged with existing imports.
 * The remaining code (if any) is inserted prior to any non-import code.
 *
 * @param state The editor state.
 * @param addition The new Python code.
 * @returns The necessary changes suitable for a CodeMirror transaction.
 * @throws AliasesNotSupportedError if the additional code contains alias imports.
 */
export const calculateChanges = (state: EditorState, addition: string) => {
  const parser = python().language.parser;
  const additionTree = parser.parse(addition);
  const additionalImports = topLevelImports(additionTree, (from, to) =>
    addition.slice(from, to)
  );
  const endOfAdditionalImports =
    additionalImports[additionalImports.length - 1]?.node?.to ?? 0;
  addition = addition.slice(endOfAdditionalImports).trim();
  const requiredImports = additionalImports.flatMap(
    convertImportNodeToRequiredImports
  );
  const allCurrentImports = currentImports(state);

  const changes = requiredImports.flatMap((required) =>
    calculateImportChangesInternal(allCurrentImports, required)
  );
  if (changes.length > 0 && allCurrentImports.length === 0) {
    // Two blank lines separating the imports from everything else.
    changes[changes.length - 1].insert += "\n\n";
  }

  // We'll want to add more sophisticated insertion than this.
  if (addition) {
    // We always want a newline at the end as for now our inserts are whole lines.
    // If the insertion point is after a node then we want an newline before it.
    // If the insertion point is before a node then we want an newline after it to break the line.
    const lastImport = allCurrentImports?.[allCurrentImports.length - 1]?.node;
    let relation = Relation.Default;
    let insertionPoint = 0;
    if (lastImport?.nextSibling) {
      relation = Relation.Before;
      insertionPoint = lastImport.nextSibling.from;
    } else if (lastImport) {
      relation = Relation.After;
      insertionPoint = lastImport.to;
    }

    changes.push({
      from: insertionPoint,
      insert:
        (relation === Relation.After ? "\n" : "") +
        addition +
        "\n" +
        (relation === Relation.Before ? "\n" : ""),
    });
  }
  return changes;
};

const currentImports = (state: EditorState): ImportNode[] => {
  const tree = syntaxTree(state);
  return topLevelImports(tree, (from, to) => state.sliceDoc(from, to));
};

const topLevelImports = (
  tree: Tree,
  text: (from: number, to: number) => string
): ImportNode[] => {
  const imports: (ImportNode | undefined)[] = tree.topNode
    .getChildren("ImportStatement")
    .map((existingImport) => {
      // The tree is flat here, so making sense of this is distressingly like parsing it again.
      // (1) kw<"from"> (("." | "...")+ dottedName? | dottedName) kw<"import"> ("*" | importList | importedNames)
      // (2) kw<"import"> dottedName (kw<"as"> VariableName)? |
      if (existingImport.firstChild?.name === "from") {
        const moduleNode = existingImport.getChild("VariableName");
        if (!moduleNode) {
          return undefined;
        }
        const module = text(moduleNode.from, moduleNode.to);
        const importNode = existingImport.getChild("import");
        if (!importNode) {
          return undefined;
        }
        const names: ImportedName[] = [];
        let current: ImportedName | undefined;
        for (
          let node = importNode.nextSibling;
          node;
          node = node?.nextSibling
        ) {
          const isVariableName = node.name === "VariableName";
          if (current) {
            if (isVariableName) {
              current.alias = text(node.from, node.to);
            } else if (
              node.name === "as" ||
              node.name === "(" ||
              node.name === ")"
            ) {
              continue;
            } else if (node.name === ",") {
              names.push(current);
              current = undefined;
            }
          } else {
            current = {
              name: text(node.from, node.to),
            };
          }
        }
        if (current) {
          names.push(current);
        }
        return { module, names, kind: "from", node: existingImport };
      } else if (existingImport.firstChild?.name === "import") {
        const variableNames = existingImport.getChildren("VariableName");
        if (variableNames.length === 0) {
          return undefined;
        }
        return {
          module: text(variableNames[0].from, variableNames[0].to),
          alias:
            variableNames.length === 2
              ? text(variableNames[1].from, variableNames[1].to)
              : undefined,
          kind: "import",
          node: existingImport,
        };
      }
      return undefined;
    });
  return imports.filter((x: ImportNode | undefined): x is ImportNode => !!x);
};

/**
 * Flattens an import node into the imported names.
 * Throws if aliases are encountered.
 */
const convertImportNodeToRequiredImports = (
  actualImport: ImportNode
): RequiredImport[] => {
  if (actualImport.kind === "from") {
    return (actualImport.names ?? []).map((name) => {
      if (name.alias) {
        throw new AliasesNotSupportedError();
      }
      return {
        module: actualImport.module,
        name: name.name,
      };
    });
  }
  if (actualImport.alias) {
    throw new AliasesNotSupportedError();
  }
  return [
    {
      module: actualImport.module,
    },
  ];
};
