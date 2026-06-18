export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  Decimal: { input: any; output: any; }
};

export type Attribute = {
  __typename?: 'Attribute';
  key: Scalars['String']['output'];
  value?: Maybe<Scalars['String']['output']>;
};

export type Cart = {
  __typename?: 'Cart';
  lines: Array<CartLine>;
};

export type CartLine = {
  __typename?: 'CartLine';
  attribute?: Maybe<Attribute>;
  id: Scalars['ID']['output'];
  merchandise: Merchandise;
  quantity: Scalars['Int']['output'];
};


export type CartLineAttributeArgs = {
  key: Scalars['String']['input'];
};

export type Merchandise = ProductVariant;

export type ProductVariant = {
  __typename?: 'ProductVariant';
  id: Scalars['ID']['output'];
};

export type Query = {
  __typename?: 'Query';
  cart: Cart;
};

export type RunInputQueryVariables = Exact<{ [key: string]: never; }>;


export type RunInputQuery = { __typename?: 'Query', cart: { __typename?: 'Cart', lines: Array<{ __typename?: 'CartLine', id: string, quantity: number, merchandise: { __typename?: 'ProductVariant', id: string }, mikoData?: { __typename?: 'Attribute', value?: string | null } | null }> } };
